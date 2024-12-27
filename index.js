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
    
    // Add seasonal and other bonuses
    const seasonalBonus = getSeasonalBonus();
    discountPercentage += seasonalBonus;
    if (isLimitedTimeOffer()) {
      discountPercentage += 5;
    }
    
    console.log(`Applying ${discountPercentage}% total discount (including ${seasonalBonus}% seasonal bonus)`);

    // Update prices for all variants
    console.log('Updating compare-at prices');
    for (const variant of product.variants) {
      try {
        const variantPrice = parseFloat(variant.price);
        const volumeDiscount = getVolumeDiscount(variantPrice);
        const totalDiscount = discountPercentage + volumeDiscount;
        
        // Calculate prices
        const compareAtPrice = applyPsychologicalPricing(variantPrice * markupPercentage);
        const salePrice = applyPsychologicalPricing(variantPrice * (1 - totalDiscount/100));
        
        // Update variant prices
        await shopify.productVariant.update(variant.id, {
          compare_at_price: compareAtPrice,
          price: salePrice
        });
        
        console.log(`Updated variant ${variant.id}:`);
        console.log(`- Compare at price: ${compareAtPrice}`);
        console.log(`- Sale price: ${salePrice}`);
        console.log(`- Total discount: ${totalDiscount}%`);
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

// Webhook endpoint for product updates
app.post('/webhooks/products/update', async (req, res) => {
  try {
    if (!verifyWebhook(req)) {
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

// Health check endpoint
app.get('/', (req, res) => {
  res.send('Price Adjuster Service Running');
});

// Manual trigger endpoint
app.post('/update-prices', async (req, res) => {
  try {
    const products = await shopify.product.list({
      collection_id: process.env.SALE_COLLECTION_ID,
      limit: 250
    });

    for (const product of products) {
      await updateProductPrice(product.id);
    }
    
    res.send(`Price update completed for ${products.length} products`);
  } catch (error) {
    console.error('Manual update error:', error);
    res.status(500).send('Error updating prices');
  }
});

// Run the check every 12 hours instead of 6
setInterval(checkForSaleProducts, 12 * 60 * 60 * 1000);

// Run initial check on startup
checkForSaleProducts();

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
  console.log('Price Adjuster Service Started');
});