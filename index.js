require('dotenv').config();
const express = require('express');
const Shopify = require('shopify-api-node');
const crypto = require('crypto');

const app = express();
const port = process.env.PORT || 3000;

app.use(express.raw({type: 'application/json'}));

const shopify = new Shopify({
  shopName: process.env.SHOP_NAME,
  accessToken: process.env.ACCESS_TOKEN,
  apiVersion: '2024-01'
});

const processedProducts = new Set();
const DEBOUNCE_TIME = 30000; // 30 seconds

const categoryMarkups = {
  // Dresses
  'casual_day_dress': { min: 1.8, max: 2.2 },
  'party_evening_dress': { min: 2.3, max: 2.8 },
  'maxi_midi_dress': { min: 2.0, max: 2.5 },
  
  // Tops & Blouses
  't_shirts_tanks': { min: 1.5, max: 1.8 },
  'blouses_shirts': { min: 1.8, max: 2.2 },
  'knits_sweaters': { min: 2.0, max: 2.4 },
  
  // Bottoms
  'pants_jeans': { min: 1.8, max: 2.2 },
  'skirts': { min: 1.7, max: 2.0 },
  'leggings': { min: 1.5, max: 1.8 },
  
  // Activewear
  'workout_sets': { min: 1.8, max: 2.2 },
  'sports_tops': { min: 1.5, max: 1.8 },
  'active_leggings': { min: 1.6, max: 1.9 },
  'loungewear': { min: 1.7, max: 2.0 },
  
  // Outerwear
  'jackets_coats': { min: 2.3, max: 2.8 },
  'cardigans_blazers': { min: 2.0, max: 2.4 },
  
  // Default
  'default': { min: 1.8, max: 2.2 }
};

function determineProductType(product) {
  const title = product.title.toLowerCase();
  const productType = product.product_type.toLowerCase();
  
  if (title.includes('dress')) {
    if (title.includes('party') || title.includes('evening')) return 'party_evening_dress';
    if (title.includes('maxi') || title.includes('midi')) return 'maxi_midi_dress';
    return 'casual_day_dress';
  }
  
  if (title.includes('jacket') || title.includes('coat')) return 'jackets_coats';
  if (title.includes('cardigan') || title.includes('blazer')) return 'cardigans_blazers';
  if (title.includes('sweater') || title.includes('knit')) return 'knits_sweaters';
  if (title.includes('legging')) return productType.includes('active') ? 'active_leggings' : 'leggings';
  if (title.includes('workout') || title.includes('set')) return 'workout_sets';
  if (title.includes('sport') || title.includes('tank')) return 'sports_tops';
  
  if (productType.includes('t-shirt') || productType.includes('tank')) return 't_shirts_tanks';
  if (productType.includes('blouse') || productType.includes('shirt')) return 'blouses_shirts';
  if (productType.includes('pant') || productType.includes('jean')) return 'pants_jeans';
  if (productType.includes('skirt')) return 'skirts';
  
  return 'default';
}

function calculateDiscount(basePrice, productType) {
  const markup = categoryMarkups[productType] || categoryMarkups.default;
  
  let finalMarkup;
  if (basePrice < 30) {
    finalMarkup = markup.min;
  } else if (basePrice < 60) {
    finalMarkup = (markup.min + markup.max) / 2;
  } else {
    finalMarkup = markup.max;
  }

  const variation = (Math.random() * 0.1) - 0.05; // ±5%
  finalMarkup += variation;
  
  finalMarkup = Math.max(1.2, Math.min(finalMarkup, 3.0));
  
  return ((1 - 1/finalMarkup) * 100).toFixed(2);
}

function roundToNicePrice(price) {
  return Math.ceil(price) - 0.01;
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
    console.log(`Checking if product ${productId} is in Sale collection ${process.env.SALE_COLLECTION_ID}`);
    
    const collectionProducts = await shopify.collection.products.list({
      collection_id: process.env.SALE_COLLECTION_ID
    });

    const isInSaleCollection = collectionProducts.some(p => 
      p.id.toString() === productId.toString()
    );

    if (!isInSaleCollection) {
      console.log(`Product ${productId} not in Sale collection - clearing compare-at price`);
      await clearCompareAtPrice(productId);
      return;
    }

    processedProducts.add(productId);
    console.log('Processing product:', productId);
    
    const product = await shopify.product.get(productId);
    const basePrice = parseFloat(product.variants[0].price);
    
    const productType = determineProductType(product);
    const discountPercentage = calculateDiscount(basePrice, productType);
    
    const markup = 100 / (100 - parseFloat(discountPercentage));
    const compareAtPrice = roundToNicePrice(basePrice * markup);
    
    console.log(`Product Type: ${productType}, Base Price: ${basePrice}, Discount: ${discountPercentage}%, Compare At: ${compareAtPrice}`);

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
        const variantBasePrice = parseFloat(variant.price);
        const variantCompareAtPrice = roundToNicePrice(variantBasePrice * markup);
        
        await shopify.productVariant.update(variant.id, {
          compare_at_price: variantCompareAtPrice.toFixed(2)
        });
        console.log(`Updated variant ${variant.id} with ${discountPercentage}% discount (${variantCompareAtPrice} → ${variantBasePrice})`);
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
      const products = await shopify.collection.products.list({
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
    console.log('Starting manual price update for Sale collection');
    let page = 1;
    let hasMore = true;
    const processedIds = new Set();

    while (hasMore) {
      const response = await shopify.collection.products.list({
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
  console.log('Category-based pricing enabled');
});