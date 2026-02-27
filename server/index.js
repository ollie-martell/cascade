require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
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

// Serve frontend
app.use(express.static(path.join(__dirname, '../client')));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, '../client/index.html')));

app.listen(PORT, () => {
  console.log(`\n🌊 Cascade server running on http://localhost:${PORT}`);
  console.log(`   Health: http://localhost:${PORT}/api/health\n`);
});
