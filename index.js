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
// Modify the price calculation function to ensure no negative values
function applyPsychologicalPricing(price) {
  const flooredPrice = Math.max(0.01, Math.floor(price) - 0.01);
  return flooredPrice.toFixed(2);
}

// Function to update product prices
async function updateProductPrice(productId) {
  try {
    console.log('Processing product:', productId);
    
    // Get product details and handle 404 gracefully
    let product;
    try {
      product = await shopify.product.get(productId);
    } catch (error) {
      if (error.response?.status === 404) {
        console.log(`Product ${productId} not found, skipping`);
        return;
      }
      throw error;
    }

    const basePrice = parseFloat(product.variants[0].price);
    
    // Calculate discount with caps and floors
    const minimumPrice = 0.01;
    const markupPercentage = 2.0;
    let discountPercentage = getRandomDiscount();
    
    // Add additional discounts
    const seasonalBonus = getSeasonalBonus();
    discountPercentage += seasonalBonus;
    
    if (isLimitedTimeOffer()) {
      discountPercentage += 5;
    }
    
    // Cap maximum discount to prevent negative prices
    discountPercentage = Math.min(discountPercentage, 90); // Max 90% discount

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

    // If no metafield exists, create it with USD currency
    if (!originalPrice) {
      const suggestedPrice = (basePrice * markupPercentage).toFixed(2);
      console.log('Creating metafield with original price:', suggestedPrice);
      originalPrice = await shopify.metafield.create({
        namespace: 'price_automation',
        key: 'original_price',
        value: JSON.stringify({
          amount: parseFloat(suggestedPrice),
          currency_code: 'USD'  // Changed from CAD to USD
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
        
        // Calculate and validate prices
        const compareAtPrice = Math.max(
          minimumPrice,
          applyPsychologicalPricing(variantPrice * markupPercentage)
        );
        
        const calculatedSalePrice = variantPrice * (1 - totalDiscount/100);
        const salePrice = Math.max(
          minimumPrice,
          applyPsychologicalPricing(calculatedSalePrice)
        );
        
        // Additional validation before update
        if (salePrice <= 0 || compareAtPrice <= 0) {
          console.error(`Invalid prices calculated for variant ${variant.id}: sale=${salePrice}, compare=${compareAtPrice}`);
          continue;
        }

        // Only update if prices are valid
        await shopify.productVariant.update(variant.id, {
          compare_at_price: compareAtPrice,
          price: salePrice
        });

        console.log(`Updated variant ${variant.id}:`);
        console.log(`- Compare at price: ${compareAtPrice}`);
        console.log(`- Sale price: ${salePrice}`);
        console.log(`- Total discount: ${totalDiscount}%`);
      } catch (error) {
        console.error(`Error updating variant ${variant.id} prices:`, error.response?.body || error);
      }
    }
    
    console.log('Successfully processed product:', product.title);
  } catch (error) {
    console.error('Error updating product price:', error.response?.body || error);
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

// Product update webhook
app.post('/webhooks/products/update', async (req, res) => {
  try {
    console.log('Received product update webhook');
    console.log('Request headers:', req.headers);
    console.log('Request body:', req.body.toString());

    if (!verifyWebhook(req)) {
      console.log('Invalid webhook signature');
      return res.status(401).send('Invalid webhook signature');
    }

    const data = JSON.parse(req.body);
    console.log('Webhook data:', data);
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

// Manual trigger endpoint
app.post('/update-prices', async (req, res) => {
  try {
    console.log('Manual price update triggered');
    let page = 1;
    let products = [];

    // Fetch all products in the sale collection
    do {
      const response = await shopify.product.list({
        collection_id: process.env.SALE_COLLECTION_ID,
        limit: 250,
        page: page
      });
      products = response;
      page++;

      console.log(`Processing page ${page} with ${products.length} products`);
      for (const product of products) {
        await updateProductPrice(product.id);
      }
    } while (products.length > 0);
    
    res.send('Price update completed');
  } catch (error) {
    console.error('Manual update error:', error);
    res.status(500).send('Error updating prices');
  }
});

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
  console.log('Price Adjuster Service Started');
});