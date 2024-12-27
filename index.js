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

// Function to apply psychological pricing (e.g., $99.99 instead of $100)
function applyPsychologicalPricing(price) {
  return (Math.floor(price) - 0.01).toFixed(2);
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
    
    // Get product details
    const product = await shopify.product.get(productId);
    const basePrice = parseFloat(product.variants[0].price);
    
    // Calculate markup and discounts
    const markupPercentage = 2.0; // 100% markup for better perceived value
    let discountPercentage = getRandomDiscount();
    
    // Add seasonal bonus discount
    const seasonalBonus = getSeasonalBonus();
    discountPercentage += seasonalBonus;
    
    // Add flash sale bonus if during peak hours
    if (isLimitedTimeOffer()) {
      discountPercentage += 5; // Additional 5% off during flash sale
    }
    
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

    // Update compare-at price for all variants
    console.log('Updating compare-at prices');
    for (const variant of product.variants) {
      try {
        const variantPrice = parseFloat(variant.price);
        const volumeDiscount = getVolumeDiscount(variantPrice);
        const totalDiscount = discountPercentage + volumeDiscount;
        
        // Calculate prices
        const compareAtPrice = applyPsychologicalPricing(variantPrice * markupPercentage);
        const salePrice = applyPsychologicalPricing(variantPrice * (1 - totalDiscount/100));
        
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
    const collections = await shopify.product.listCollections(productId);
    return collections.some(collection => collection.id.toString() === process.env.SALE_COLLECTION_ID);
  } catch (error) {
    console.error('Error checking collection membership:', error);
    return false;
  }
}

// Function to add product to sale collection
async function addToSaleCollection(productId) {
  try {
    // Use custom collection
    await shopify.customCollection.addProducts(process.env.SALE_COLLECTION_ID, [productId]);
    console.log(`Added product ${productId} to sale collection`);
    return true;
  } catch (error) {
    console.error('Error adding to sale collection:', error);
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
    
    // Check if product has sale-related tags
    const tags = (data.tags || '').split(',').map(tag => tag.trim().toLowerCase());
    const saleRelatedTags = ['sale', 'clearance', 'discount', 'promotion'];
    
    if (saleRelatedTags.some(tag => tags.includes(tag))) {
      // If product has sale tags but isn't in sale collection, add it
      if (!(await isInSaleCollection(data.id))) {
        await addToSaleCollection(data.id);
      }
    }
    
    await updateProductPrice(data.id);
    res.status(200).send('Webhook processed');
  } catch (error) {
    console.error('Webhook processing error:', error);
    res.status(500).send('Webhook processing failed');
  }
});

// Collection update webhook
app.post('/webhooks/collections/update', async (req, res) => {
  try {
    console.log('Received collection update webhook');
    console.log('Request headers:', req.headers);
    console.log('Request body:', req.body.toString());

    if (!verifyWebhook(req)) {
      console.log('Invalid webhook signature');
      return res.status(401).send('Invalid webhook signature');
    }

    const data = JSON.parse(req.body);
    console.log('Webhook data:', data);
    if (data.id === process.env.SALE_COLLECTION_ID) {
      const products = await shopify.product.list({
        collection_id: data.id
      });
      
      for (const product of products) {
        await updateProductPrice(product.id);
      }
    }
    res.status(200).send('Collection webhook processed');
  } catch (error) {
    console.error('Collection webhook processing error:', error);
    res.status(500).send('Collection webhook processing failed');
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

// Add new endpoint to move products to sale collection
app.post('/move-to-sale', async (req, res) => {
  try {
    const { productIds } = req.body;
    console.log('Moving products to sale collection:', productIds);
    
    const results = await Promise.all(productIds.map(async (productId) => {
      const added = await addToSaleCollection(productId);
      if (added) {
        await updateProductPrice(productId);
        return { productId, status: 'success' };
      }
      return { productId, status: 'failed' };
    }));
    
    res.json({ message: 'Products processed', results });
  } catch (error) {
    console.error('Error moving products to sale:', error);
    res.status(500).send('Error moving products to sale');
  }
});

// Add scheduled task to check for products that should be on sale
async function checkForSaleProducts() {
  try {
    console.log('Checking for products that should be on sale...');
    
    // Get all products with sale-related tags
    let page = 1;
    let hasMore = true;
    
    while (hasMore) {
      const products = await shopify.product.list({
        limit: 250,
        page: page,
        // Filter by tags if possible
        fields: 'id,tags'
      });
      
      if (products.length === 0) {
        hasMore = false;
        continue;
      }
      
      for (const product of products) {
        const tags = (product.tags || '').split(',').map(tag => tag.trim().toLowerCase());
        const shouldBeOnSale = tags.some(tag => ['sale', 'clearance', 'discount', 'promotion'].includes(tag));
        
        if (shouldBeOnSale && !(await isInSaleCollection(product.id))) {
          console.log(`Product ${product.id} should be on sale, adding to sale collection...`);
          await addToSaleCollection(product.id);
          await updateProductPrice(product.id);
        }
      }
      
      page++;
    }
    
    console.log('Finished checking for sale products');
  } catch (error) {
    console.error('Error in scheduled check:', error);
  }
}

// Run the check every 6 hours
setInterval(checkForSaleProducts, 6 * 60 * 60 * 1000);

// Run initial check on startup
checkForSaleProducts();

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
  console.log('Price Adjuster Service Started');
});