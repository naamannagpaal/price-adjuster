require('dotenv').config();
const express = require('express');
const Shopify = require('shopify-api-node');
const crypto = require('crypto');
const path = require('path');

const app = express();
const port = process.env.PORT || 3000;

// Add body parsing middleware
app.use(express.raw({type: 'application/json'}));

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));

const shopify = new Shopify({
  shopName: process.env.SHOP_NAME,
  accessToken: process.env.ACCESS_TOKEN,
  apiVersion: '2024-01'
});

// Verify Shopify webhook
function verifyWebhook(req) {
  const hmac = req.headers['x-shopify-hmac-sha256'];
  const secret = process.env.SHOPIFY_WEBHOOK_SECRET;

  if (!secret) {
    throw new Error('SHOPIFY_WEBHOOK_SECRET is not defined');
  }

  const hash = crypto
    .createHmac('sha256', secret)
    .update(req.body.toString('utf8'))
    .digest('base64');
  return hmac === hash;
}

// Function to update product prices
async function updateProductPrice(productId) {
  try {
    console.log(`Processing product: ${productId}`);
    
    // Get product metafields
    const metafields = await shopify.metafield.list({
      metafield: {
        owner_id: productId,
        owner_resource: 'product'
      }
    });
    console.log(`Metafields for product ${productId}:`, metafields);

    const originalPrice = metafields.find(
      m => m.namespace === 'price_automation' && m.key === 'original_price'
    );
    console.log(`Original price metafield for product ${productId}:`, originalPrice);

    if (originalPrice) {
      // Get product variants
      const product = await shopify.product.get(productId);
      console.log(`Product details for ${productId}:`, product);
      
      // Update each variant
      for (const variant of product.variants) {
        console.log(`Updating variant ${variant.id} with compare_at_price: ${originalPrice.value}`);
        await shopify.productVariant.update(variant.id, {
          compare_at_price: originalPrice.value
        });
      }
      console.log(`Updated prices for product: ${product.title}`);
    } else {
      console.log(`No original price metafield found for product ${productId}`);
    }
  } catch (error) {
    console.error('Error updating product price:', error);
  }
}

// Webhook endpoint for product updates
app.post('/webhooks/products/update', async (req, res) => {
  try {
    // Verify webhook
    if (!verifyWebhook(req)) {
      res.status(401).send('Invalid webhook signature');
      return;
    }

    const data = JSON.parse(req.body);
    await updateProductPrice(data.id);
    
    res.status(200).send('Webhook processed');
  } catch (error) {
    console.error('Webhook processing error:', error);
    res.status(500).send('Webhook processing failed');
  }
});

// Webhook endpoint for collection updates
app.post('/webhooks/collections/update', async (req, res) => {
  try {
    // Verify webhook
    if (!verifyWebhook(req)) {
      res.status(401).send('Invalid webhook signature');
      return;
    }

    const data = JSON.parse(req.body);
    if (data.id === process.env.SALE_COLLECTION_ID) {
      // Process all products in collection
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
  res.send('Price Adjuster Service Running');
});

// Manual trigger endpoint
app.post('/update-prices', async (req, res) => {
  try {
    const products = await shopify.product.list({
      collection_id: process.env.SALE_COLLECTION_ID
    });

    for (const product of products) {
      await updateProductPrice(product.id);
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