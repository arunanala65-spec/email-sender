// Vercel serverless wrapper: semua request masuk ke Express app di server.js
const app = require('../server');
module.exports = (req, res) => app(req, res);
