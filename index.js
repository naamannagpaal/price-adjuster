require('dotenv').config();
const express = require('express');
const Shopify = require('shopify-api-node');
const crypto = require('crypto');

const app = express();
const port = process.env.PORT || 3000;

// Add body parsing middleware
app.use(express.raw({type: 'application/json'}));

const shopify = new Shopify({
  shopName: process.env.SHOP_NAME,
  accessToken: process.env.ACCESS_TOKEN,
  apiVersion: '2024-01'
});

// Function to get random discount percentage between min and max
function getRandomDiscount(min = 25, max = 60) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

// Modify the price calculation to ensure no negative values
function applyPsychologicalPricing(price) {
  const flooredPrice = Math.max(0.01, Math.floor(price) - 0.01);
  return flooredPrice.toFixed(2);
}

// Function to get seasonal discount bonus
function getSeasonalBonus() {
  const date = new Date();
  const month = date.getMonth();
  // Extra discounts for holiday seasons
  if (month === 11) return 10; // December
  if (month === 6) return 5;   // July (Summer sale)
  if (month === 3) return 5;   // April (Spring sale)
  return 0;
}

// Function to get volume-based discount
function getVolumeDiscount(price) {
  if (price >= 100) return 5;  // Extra 5% off for items $100+
  if (price >= 50) return 3;   // Extra 3% off for items $50+
  return 0;
}

// Function to create urgency with time-limited offers
function isLimitedTimeOffer() {
  const date = new Date();
  const hour = date.getHours();
  // Flash sale during peak shopping hours (12pm-2pm and 7pm-9pm)
  return (hour >= 12 && hour <= 14) || (hour >= 19 && hour <= 21);
}

// Function to update product prices
async function updateProductPrice(productId) {
  try {
    console.log('Processing product:', productId);
    
    const product = await shopify.product.get(productId);
    const basePrice = parseFloat(product.variants[0].price);
    
    // Ensure minimum price
    const minimumPrice = 0.01;
    const markupPercentage = 2.0;
    let discountPercentage = getRandomDiscount();
    
    const seasonalBonus = getSeasonalBonus();
    discountPercentage += seasonalBonus;
    
    if (isLimitedTimeOffer()) {
      discountPercentage += 5;
    }
    
    // Cap maximum discount to prevent negative prices
    discountPercentage = Math.min(discountPercentage, 90); // Max 90% discount
    
    console.log(`Applying ${discountPercentage}% total discount (including ${seasonalBonus}% seasonal bonus)`);

    // Check if metafield exists
    const metafields = await shopify.metafield.list({
      metafield: {
        owner_id: productId,
        owner_resource: 'product'
      }
    });

    let originalPrice = metafields.find(
      m => m.namespace === 'price_automation' && m.key === 'original_price'
    );

    // If no metafield exists, create it with a markup
    if (!originalPrice) {
      const suggestedPrice = (basePrice * markupPercentage).toFixed(2);
      console.log('Creating metafield with original price:', suggestedPrice);
      originalPrice = await shopify.metafield.create({
        namespace: 'price_automation',
        key: 'original_price',
        value: JSON.stringify({
          amount: parseFloat(suggestedPrice),
          currency_code: 'USD' // Changed from CAD to USD
        }),
        type: 'money',
        owner_resource: 'product',
        owner_id: productId
      });
    }

    let originalPriceValue = parseFloat(JSON.parse(originalPrice.value).amount);

    // Ensure compare-at price is higher than base price
    if (originalPriceValue <= basePrice) {
      originalPriceValue = (basePrice * markupPercentage).toFixed(2);
      console.log(`Adjusted compare_at_price to ${originalPriceValue} (${markupPercentage}x markup from ${basePrice})`);
    }

    // Update variants with safety checks
    for (const variant of product.variants) {
      try {
        const variantPrice = parseFloat(variant.price);
        const volumeDiscount = getVolumeDiscount(variantPrice);
        const totalDiscount = Math.min(discountPercentage + volumeDiscount, 90);
        
        // Ensure prices are valid
        const compareAtPrice = Math.max(
          minimumPrice,
          applyPsychologicalPricing(variantPrice * markupPercentage)
        );
        const salePrice = Math.max(
          minimumPrice,
          applyPsychologicalPricing(variantPrice * (1 - totalDiscount/100))
        );
        
        // Verify prices before update
        if (salePrice <= 0 || compareAtPrice <= 0) {
          console.error(`Invalid prices calculated for variant ${variant.id}: sale=${salePrice}, compare=${compareAtPrice}`);
          continue;
        }

        // Add tags for marketing
        const tags = [
          'sale',
          seasonalBonus > 0 ? 'seasonal-sale' : null,
          isLimitedTimeOffer() ? 'flash-sale' : null,
          volumeDiscount > 0 ? 'volume-discount' : null
        ].filter(Boolean);

        await shopify.productVariant.update(variant.id, {
          compare_at_price: compareAtPrice,
          price: salePrice
        });

        // Update product tags
        await shopify.product.update(productId, {
          tags: [...new Set([...product.tags.split(','), ...tags])].join(',')
        });
        
        console.log(`Updated variant ${variant.id}:`);
        console.log(`- Compare at price: ${compareAtPrice}`);
        console.log(`- Sale price: ${salePrice}`);
        console.log(`- Total discount: ${totalDiscount}%`);
        console.log(`- Applied tags: ${tags.join(', ')}`);
      } catch (error) {
        console.error(`Error updating variant ${variant.id} prices:`, error.response ? error.response.body : error);
      }
    }
    
    console.log('Successfully processed product:', product.title);
  } catch (error) {
    console.error('Error updating product price:', error.response ? error.response.body : error);
  }
}

// Webhook verification
function verifyWebhook(req) {
  const hmac = req.headers['x-shopify-hmac-sha256'];
  const hash = crypto
    .createHmac('sha256', process.env.SHOPIFY_WEBHOOK_SECRET)
    .update(req.body)
    .digest('base64');
  return hmac === hash;
}

// Function to check if product is in sale collection
async function isInSaleCollection(productId) {
  try {
    // Get products in sale collection
    const products = await shopify.product.list({
      collection_id: process.env.SALE_COLLECTION_ID,
      limit: 250,
      fields: 'id'
    });
    
    return products.some(p => p.id.toString() === productId.toString());
  } catch (error) {
    console.error('Error checking collection membership:', error);
    return false;
  }
}

// Modified product update webhook
app.post('/webhooks/products/update', async (req, res) => {
  try {
    console.log('Received product update webhook');
    if (!verifyWebhook(req)) {
      console.log('Invalid webhook signature');
      return res.status(401).send('Invalid webhook signature');
    }

    const data = JSON.parse(req.body);
    console.log('Webhook data:', data);
    
    // Only update price if product is in sale collection
    if (await isInSaleCollection(data.id)) {
      await updateProductPrice(data.id);
    }
    
    res.status(200).send('Webhook processed');
  } catch (error) {
    console.error('Webhook processing error:', error);
    res.status(500).send('Webhook processing failed');
  }
});

// Health check endpoint
app.get('/', (req, res) => {
  console.log('Health check endpoint hit');
  res.send('Price Adjuster Service Running');
});

// Function to process all products in a collection
async function processCollection(collectionId) {
  try {
    console.log(`Processing collection: ${collectionId}`);
    let processedCount = 0;
    let page = 1;
    let hasMoreProducts = true;

    while (hasMoreProducts) {
      console.log(`Fetching page ${page}...`);
      const products = await shopify.product.list({
        collection_id: collectionId,
        limit: 250,
        page: page
      });

      if (products.length === 0) {
        hasMoreProducts = false;
        continue;
      }

      console.log(`Found ${products.length} products on page ${page}`);
      
      // Process products in parallel with rate limiting
      const promises = products.map((product, index) => {
        return new Promise(resolve => {
          // Add delay between requests to avoid rate limits
          setTimeout(async () => {
            try {
              await updateProductPrice(product.id);
              processedCount++;
              console.log(`Progress: ${processedCount} products processed`);
              resolve();
            } catch (error) {
              console.error(`Error processing product ${product.id}:`, error);
              resolve();
            }
          }, index * 500); // 500ms delay between each product
        });
      });

      await Promise.all(promises);
      page++;
    }

    return processedCount;
  } catch (error) {
    console.error('Error processing collection:', error);
    throw error;
  }
}

// Manual trigger endpoint with progress tracking
app.post('/update-prices', async (req, res) => {
  try {
    console.log('Manual price update triggered');
    
    // Send initial response
    res.write('Starting price update process...\n');
    
    const collectionId = process.env.SALE_COLLECTION_ID;
    const processedCount = await processCollection(collectionId);
    
    const summary = `Completed processing ${processedCount} products in collection ${collectionId}`;
    console.log(summary);
    res.end(summary);
  } catch (error) {
    console.error('Manual update error:', error);
    res.status(500).send('Error updating prices');
  }
});

// Add scheduled task to check for products that should be on sale
async function checkForSaleProducts() {
  try {
    console.log('Checking for products that should be on sale...');
    let processedCount = 0;
    let page = 1;
    let hasMore = true;
    
    while (hasMore) {
      try {
        const products = await shopify.product.list({
          limit: 50, // Reduced limit to avoid rate limits
          page: page,
          fields: 'id,tags,title'
        });
        
        if (products.length === 0) {
          hasMore = false;
          break;
        }
        
        console.log(`Processing page ${page} with ${products.length} products`);
        
        for (const product of products) {
          const tags = (product.tags || '').split(',').map(tag => tag.trim().toLowerCase());
          const shouldBeOnSale = tags.some(tag => ['sale', 'clearance', 'discount', 'promotion'].includes(tag));
          
          if (shouldBeOnSale) {
            console.log(`Processing sale product: ${product.title} (${product.id})`);
            await updateProductPrice(product.id);
            processedCount++;
          }
        }
        
        page++;
        // Add delay between pages to avoid rate limits
        await new Promise(resolve => setTimeout(resolve, 1000));
      } catch (error) {
        console.error(`Error processing page ${page}:`, error);
        hasMore = false;
      }
    }
    
    console.log(`Finished checking for sale products. Processed ${processedCount} products`);
  } catch (error) {
    console.error('Error in scheduled check:', error);
  }
}

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
  console.log('Price Adjuster Service Started');
  // Run initial check after server starts with a small delay
  setTimeout(checkForSaleProducts, 5000);
});

// Run the check every 12 hours
setInterval(checkForSaleProducts, 12 * 60 * 60 * 1000);