# Price Adjuster for Shopify 🛒

**Automate discounts, price updates, and more for your Shopify store.**  
A smart tool to manage pricing strategies effortlessly, built with **Express.js** and **Shopify API**.

---

## What It Does 🚀
- **Dynamic Discounts**: Automatically calculates optimal discounts based on your rules.  
- **Price Updates**: Adjusts product prices and compares them with competitors.  
- **Bulk Processing**: Handles individual products and entire collections.  
- **Price History**: Tracks changes over time for better decision-making.  

---

## Features ✨
- **Category-Specific Markups**: Set different markup rules for various product categories.  
- **Smart Price Rounding**: Rounds prices to attractive, customer-friendly values.  
- **Webhook Support**: Processes product and collection updates in real-time.  
- **Price Protection**: Ensures prices stay within min/max markup ranges.  

---

## Setup 🛠️

### 1. Clone the Repository
```bash
git clone https://github.com/naamannagpaal/price-adjuster.git
cd price-adjuster
```
2. Configure Your Shopify Store
Create a `.env` file in the root directory and add your Shopify credentials:
```
SHOP_NAME=your-store.myshopify.com
ACCESS_TOKEN=your_access_token
SALE_COLLECTION_ID=your_collection_id
```

3. Install Dependencies
   ```
   npm install
   ```

4. Start the Service
   ```
   npm start
   ```
   
## API Endpoints 🌐

- **GET `/health`**: Health check endpoint.  
- **POST `/webhooks/products/update`**: Handles product updates.  
- **POST `/webhooks/collections/update`**: Processes collection updates.  
- **POST `/update-prices`**: Manually trigger price updates.  

Deployment 🚀

Ready to deploy on Vercel! Just connect your repository, and you're good to go.

Built With 🛠️

Express.js: For building the backend server.
Shopify API: To interact with your Shopify store.
Need Help? 🤔

Reach out via GitHub Issues or email contact@namannagpal.com.

License 📄

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

