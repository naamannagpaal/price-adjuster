# 🛍️ Shopify Price Adjuster

*Automate dynamic pricing, discounts, and markup rules for Shopify stores*  
*Built with Node.js + Express.js | AI-assisted with [Claude](https://claude.ai)*

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Deploy on Vercel](https://vercel.com/button)](https://vercel.com/new)
[![Node.js Version](https://img.shields.io/badge/Node.js-18.x%2B-green)](https://nodejs.org)

---

## 🌟 Features

- **Dynamic Pricing Engine**  
  Auto-calculate discounts & markups based on product categories
- **Bulk Processing**  
  Update prices for individual items or entire collections
- **Webhook Integration**  
  Auto-trigger updates on product/collection changes
- **Price Protection**  
  Enforce min/max margins with smart rounding ($19.99 vs $20)
- **Historical Tracking**  
  Maintain price history via Shopify metafields

---

## 🚀 Quick Start

### Prerequisites
- Shopify store with **Admin API access**
- Node.js v18+

### Installation
```bash
git clone https://github.com/naamannagpaal/price-adjuster.git
cd price-adjuster
npm install

Configuration

Create .env file:
env
Copy
SHOP_NAME=your-store.myshopify.com
ACCESS_TOKEN=your_admin_api_token
SALE_COLLECTION_ID=collections/123456789
Start service:
bash
Copy
npm start
🔌 API Endpoints

Endpoint	Method	Description
/	GET	Health check
/webhooks/products/update	POST	Handle product updates
/webhooks/collections/update	POST	Process collection changes
/update-prices	POST	Manual price adjustment trigger
🛠️ How It Works

mermaid
Copy
graph TD
    A[Shopify Store] -->|Webhooks| B(Price Adjuster)
    B --> C{Apply Rules}
    C -->|Category| D[Markup Range]
    C -->|Collection| E[Bulk Discount]
    C -->|Individual| F[Smart Rounding]
    D & E & F --> G[Update Prices]
    G --> H[Shopify Metafields History]
🤖 AI Collaboration

This project was developed with assistance from Claude for:

Code optimization suggestions
README documentation structuring
Deployment workflow design
📜 License

MIT Licensed - See LICENSE.
Free for personal/commercial use with Shopify stores.

Need Help?
📧 contact@namannagpal.com | 💬 GitHub Issues
