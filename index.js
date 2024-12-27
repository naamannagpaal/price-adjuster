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

// Function to apply psychological pricing (e.g., $99.99 instead of $100)
// Modify the price calculation function to ensure no negative values
function applyPsychologicalPricing(price) {
  const flooredPrice = Math.max(0.01, Math.floor(price) - 0.01);
  return flooredPrice.toFixed(2);
}

// Function to calculate sale price
function calculateSalePrice(originalPrice, totalDiscount) {
  // Ensure minimum discount is 10% and maximum is 90%
  const boundedDiscount = Math.min(Math.max(totalDiscount, 10), 90);
  const discountMultiplier = (100 - boundedDiscount) / 100;
  return Math.max(originalPrice * discountMultiplier, 0.01);
}

// Function to calculate compare-at price
function calculateCompareAtPrice(originalPrice) {
  // Compare-at price should be higher than original price
  return originalPrice * 2;
}

async function updateProductPrice(productId) {
  try {
    console.log('Processing product:', productId);
    
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

    // Calculate base discount
    let discountPercentage = getRandomDiscount();
    const seasonalBonus = getSeasonalBonus();
    discountPercentage += seasonalBonus;
    
    if (isLimitedTimeOffer()) {
      discountPercentage += 5;
    }

    // Update variants with proper price calculations
    for (const variant of product.variants) {
      try {
        const originalPrice = parseFloat(variant.price);
        const volumeDiscount = getVolumeDiscount(originalPrice);
        const totalDiscount = Math.min(discountPercentage + volumeDiscount, 90);
        
        // Calculate new prices ensuring proper ratios
        const compareAtPrice = calculateCompareAtPrice(originalPrice);
        const salePrice = calculateSalePrice(originalPrice, totalDiscount);
        
        // Format prices with psychological pricing
        const formattedCompareAtPrice = applyPsychologicalPricing(compareAtPrice);
        const formattedSalePrice = applyPsychologicalPricing(salePrice);
        
        // Verify prices are valid and maintain proper relationship
        if (parseFloat(formattedSalePrice) >= parseFloat(formattedCompareAtPrice)) {
          console.error(`Invalid price relationship for variant ${variant.id}`);
          continue;
        }

        await shopify.productVariant.update(variant.id, {
          compare_at_price: formattedCompareAtPrice,
          price: formattedSalePrice
        });

        console.log(`Updated variant ${variant.id}:`);
        console.log(`- Original price: ${originalPrice}`);
        console.log(`- Compare at price: ${formattedCompareAtPrice}`);
        console.log(`- Sale price: ${formattedSalePrice}`);
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