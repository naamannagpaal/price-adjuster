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

// Track processed products to prevent duplicates
const processedProducts = new Set();
const DEBOUNCE_TIME = 5000; // 5 seconds

// Function to get a strategic discount percentage between 25% and 60%
function getStrategicDiscount() {
  const appealingDiscounts = [
    29.99,
    39.99,
    44.99,
    49.99,
    54.99,
    59.99
  ];
  return appealingDiscounts[Math.floor(Math.random() * appealingDiscounts.length)];
}

// Function to calculate markup based on desired discount
function calculateMarkup(desiredDiscountPercentage) {
  return 100 / (100 - desiredDiscountPercentage);
}

// Function to update product prices
async function updateProductPrice(productId) {
  // Check if product was recently processed
  if (processedProducts.has(productId)) {
    console.log(`Skipping product ${productId} - recently processed`);
    return;
  }

  try {
    // Add product to processed set
    processedProducts.add(productId);
    console.log('Processing product:', productId);
    
    // Get product details
    const product = await shopify.product.get(productId);
    const basePrice = parseFloat(product.variants[0].price);
    
    // Get strategic discount and calculate markup
    const discountPercentage = getStrategicDiscount();
    const markupMultiplier = calculateMarkup(discountPercentage);
    
    // Calculate compare-at price and round to .99
    const compareAtPrice = Math.ceil(basePrice * markupMultiplier * 100 - 1) / 100;
    
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

    // Create or update metafield
    if (!originalPrice) {
      console.log(`Creating metafield with compare-at price: ${compareAtPrice} (${discountPercentage}% off)`);
      originalPrice = await shopify.metafield.create({
        namespace: 'price_automation',
        key: 'original_price',
        value: JSON.stringify({
          amount: compareAtPrice,
          currency_code: 'USD'
        }),
        type: 'money',
        owner_resource: 'product',
        owner_id: productId
      });
    }

    // Update compare-at price for all variants
    console.log('Updating compare-at prices');
    for (const variant of product.variants) {
      try {
        await shopify.productVariant.update(variant.id, {
          compare_at_price: compareAtPrice.toFixed(2)
        });
        console.log(`Updated variant ${variant.id} with ${discountPercentage}% discount (${compareAtPrice} → ${variant.price})`);
      } catch (error) {
        console.error(`Error updating variant ${variant.id}:`, error.response ? error.response.body : error);
      }
    }
    
    console.log('Successfully processed product:', product.title);

    // Remove product from processed set after DEBOUNCE_TIME
    setTimeout(() => {
      processedProducts.delete(productId);
    }, DEBOUNCE_TIME);
  } catch (error) {
    console.error('Error updating product price:', error.response ? error.response.body : error);
    // Remove from processed set if there was an error
    processedProducts.delete(productId);
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

    if (!verifyWebhook(req)) {
      console.log('Invalid webhook signature');
      return res.status(401).send('Invalid webhook signature');
    }

    const data = JSON.parse(req.body);
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

    if (!verifyWebhook(req)) {
      console.log('Invalid webhook signature');
      return res.status(401).send('Invalid webhook signature');
    }

    const data = JSON.parse(req.body);
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

// Manual trigger endpoint with improved pagination
app.post('/update-prices', async (req, res) => {
  try {
    console.log('Manual price update triggered');
    let page = 1;
    let hasMore = true;

    while (hasMore) {
      const response = await shopify.product.list({
        collection_id: process.env.SALE_COLLECTION_ID,
        limit: 250,
        page: page
      });

      if (response.length === 0) {
        hasMore = false;
      } else {
        console.log(`Processing page ${page} with ${response.length} products`);
        for (const product of response) {
          await updateProductPrice(product.id);
        }
        page++;
      }
    }
    
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