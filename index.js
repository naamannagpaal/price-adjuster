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

const processedProducts = new Set();
const DEBOUNCE_TIME = 30000; // 30 seconds

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

function calculateMarkup(desiredDiscountPercentage) {
  return 100 / (100 - desiredDiscountPercentage);
}

async function clearCompareAtPrice(productId) {
  try {
    const product = await shopify.product.get(productId);
    for (const variant of product.variants) {
      await shopify.productVariant.update(variant.id, {
        compare_at_price: null
      });
    }
    console.log(`Cleared compare-at price for product ${productId}`);
  } catch (error) {
    console.error(`Error clearing compare-at price for product ${productId}:`, error);
  }
}

async function updateProductPrice(productId) {
  if (processedProducts.has(productId)) {
    console.log(`Skipping product ${productId} - recently processed`);
    return;
  }

  try {
    // Check if product is in Sale collection
    const productCollections = await shopify.collection.list({
      product_id: productId
    });

    const isInSaleCollection = productCollections.some(c => c.id === process.env.SALE_COLLECTION_ID);

    if (!isInSaleCollection) {
      console.log(`Skipping product ${productId} - not in Sale collection`);
      await clearCompareAtPrice(productId);
      return;
    }

    processedProducts.add(productId);
    console.log('Processing product:', productId);
    
    const product = await shopify.product.get(productId);
    const basePrice = parseFloat(product.variants[0].price);
    
    const discountPercentage = getStrategicDiscount();
    const markupMultiplier = calculateMarkup(discountPercentage);
    const compareAtPrice = Math.ceil(basePrice * markupMultiplier * 100 - 1) / 100;
    
    const metafields = await shopify.metafield.list({
      metafield: {
        owner_id: productId,
        owner_resource: 'product'
      }
    });

    let originalPrice = metafields.find(
      m => m.namespace === 'price_automation' && m.key === 'original_price'
    );

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

    for (const variant of product.variants) {
      try {
        await shopify.productVariant.update(variant.id, {
          compare_at_price: compareAtPrice.toFixed(2)
        });
        console.log(`Updated variant ${variant.id} with ${discountPercentage}% discount (${compareAtPrice} → ${variant.price})`);
      } catch (error) {
        console.error(`Error updating variant ${variant.id}:`, error.response?.body || error);
      }
    }
    
    console.log('Successfully processed product:', product.title);

    setTimeout(() => {
      processedProducts.delete(productId);
    }, DEBOUNCE_TIME);
  } catch (error) {
    console.error('Error updating product price:', error.response?.body || error);
    processedProducts.delete(productId);
  }
}

function verifyWebhook(req) {
  const hmac = req.headers['x-shopify-hmac-sha256'];
  const hash = crypto
    .createHmac('sha256', process.env.SHOPIFY_WEBHOOK_SECRET)
    .update(req.body)
    .digest('base64');
  return hmac === hash;
}

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

app.post('/webhooks/collections/update', async (req, res) => {
  try {
    if (!verifyWebhook(req)) {
      return res.status(401).send('Invalid webhook signature');
    }

    const data = JSON.parse(req.body);
    if (data.id === process.env.SALE_COLLECTION_ID) {
      const products = await shopify.product.list({
        collection_id: data.id,
        limit: 250
      });
      
      const uniqueProducts = [...new Set(products.map(p => p.id))];
      
      for (const productId of uniqueProducts) {
        await updateProductPrice(productId);
      }
    }
    res.status(200).send('Collection webhook processed');
  } catch (error) {
    console.error('Collection webhook processing error:', error);
    res.status(500).send('Collection webhook processing failed');
  }
});

app.get('/', (req, res) => {
  res.send('Price Adjuster Service Running');
});

app.post('/update-prices', async (req, res) => {
  try {
    let page = 1;
    let hasMore = true;
    const processedIds = new Set();

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
          if (!processedIds.has(product.id)) {
            processedIds.add(product.id);
            await updateProductPrice(product.id);
          }
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