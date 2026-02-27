require('dotenv').config();
const express = require('express');
const cors = require('cors');
const repurposeRoutes = require('./routes/repurpose');

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors({
  origin: ['http://localhost:3000', 'http://127.0.0.1:3000', 'http://localhost:3002', 'http://127.0.0.1:3002', 'http://localhost:5000', 'null'],
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type'],
  credentials: false,
}));

app.use(express.json({ limit: '10mb' }));

app.use('/api', repurposeRoutes);

app.listen(PORT, () => {
  console.log(`\n🌊 Cascade server running on http://localhost:${PORT}`);
  console.log(`   Health: http://localhost:${PORT}/api/health\n`);
});
