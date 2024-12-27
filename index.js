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

// Function to get a strategic discount percentage between 25% and 60%
function getStrategicDiscount() {
  // Common psychologically appealing discount numbers
  const appealingDiscounts = [
    29.99, // Just under 30%
    39.99, // Just under 40%
    44.99, // Just under 45%
    49.99, // Just under 50%
    54.99, // Just under 55%
    59.99  // Just under 60%
  ];
  
  // Randomly select from appealing discounts
  return appealingDiscounts[Math.floor(Math.random() * appealingDiscounts.length)];
}

// Function to calculate markup based on desired discount
function calculateMarkup(desiredDiscountPercentage) {
  // Convert percentage to decimal and calculate markup
  return 100 / (100 - desiredDiscountPercentage);
}

// Function to update product prices
async function updateProductPrice(productId) {
  try {
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