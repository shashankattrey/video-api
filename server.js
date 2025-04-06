require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const redis = require('redis');
const bcrypt = require('bcrypt');
const app = express();
const port = process.env.PORT || 3000;

// Log environment variables for debugging
console.log('PORT:', process.env.PORT);
console.log('DATABASE_URL:', process.env.DATABASE_URL);
console.log('REDIS_URL:', process.env.REDIS_URL);

// Database connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false, // Add SSL for production
});

pool.on('error', (err) => {
  console.error('Unexpected error on idle database client:', err.stack);
});

pool.connect((err, client, release) => {
  if (err) {
    console.error('Database connection failed:', err.stack);
    return;
  }
  console.log('Database connection successful');
  release();
});

// Redis connection
const redisClient = redis.createClient({
  url: process.env.REDIS_URL,
});
redisClient.on('error', (err) => console.error('Redis error:', err.message, err.stack));
redisClient.on('connect', () => console.log('Redis connected'));
redisClient.on('ready', () => console.log('Redis ready'));
redisClient.on('end', () => console.log('Redis connection ended'));
redisClient.connect().catch((err) => console.error('Redis connection failed:', err.message, err.stack));

app.use(express.json());

// Videos endpoint (unchanged)
app.get('/api/videos', async (req, res) => {
  const { section, limit = 10, offset = 0 } = req.query;
  const cacheKey = section ? `videos:${section}:${limit}:${offset}` : `videos:all:${limit}:${offset}`;

  try {
    const cachedData = await redisClient.get(cacheKey);
    if (cachedData) {
      console.log(`Cache hit for ${cacheKey}`);
      return res.json(JSON.parse(cachedData));
    }

    let query = section
      ? { text: 'SELECT * FROM videos WHERE section = $1 ORDER BY created_at DESC LIMIT $2 OFFSET $3', values: [section, parseInt(limit), parseInt(offset)] }
      : { text: 'SELECT * FROM videos ORDER BY created_at DESC LIMIT $1 OFFSET $2', values: [parseInt(limit) || 1000, parseInt(offset)] };
    
    const result = await pool.query(query);
    console.log('Videos returned from DB:', result.rows.length);

    await redisClient.setEx(cacheKey, 3600, JSON.stringify(result.rows));
    console.log(`Cached ${cacheKey} in Redis`);
    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching videos:', err.stack);
    res.status(500).send('Server Error');
  }
});

// Sign-up with Email/Password
app.post('/api/signup', async (req, res) => {
  const { email, password, full_name } = req.body;
  if (!email || !password || !full_name) {
    console.log('Signup failed: Missing fields', { email, password, full_name });
    return res.status(400).json({ error: 'Missing required fields' });
  }

  try {
    const hashedPassword = await bcrypt.hash(password, 10);
    console.log('Generated hash for signup:', hashedPassword);

    const query = `
      INSERT INTO users (email, password, full_name)
      VALUES ($1, $2, $3)
      ON CONFLICT (email)
      DO NOTHING
      RETURNING id, email, full_name;
    `;
    const values = [email, hashedPassword, full_name];
    const result = await pool.query(query, values);

    if (!result.rows.length) {
      console.log('Signup failed: Email already exists', { email });
      return res.status(409).json({ error: 'Email already exists' });
    }

    console.log('Signup successful:', result.rows[0]);
    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error('Error during signup:', error.stack);
    res.status(500).json({ error: 'Failed to sign up', details: error.message });
  }
});

// Sign-in with Email/Password
app.post('/api/signin', async (req, res) => {
  const { email, password } = req.body;
  console.log('Sign-in attempt:', { email, password }); // Log input

  if (!email || !password) {
    console.log('Sign-in failed: Missing email or password');
    return res.status(400).json({ error: 'Missing email or password' });
  }

  try {
    const query = 'SELECT id, email, password, full_name FROM users WHERE email = $1';
    const result = await pool.query(query, [email]);
    console.log('DB result:', result.rows); // Log what DB returns

    if (!result.rows.length) {
      console.log('Sign-in failed: No user found for', email);
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const user = result.rows[0];
    console.log('Stored password hash:', user.password); // Log stored hash

    const isMatch = await bcrypt.compare(password, user.password || '');
    console.log('Password match:', isMatch); // Log match result

    if (!isMatch) {
      console.log('Sign-in failed: Password mismatch for', email);
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    console.log('Sign-in successful:', { id: user.id, email: user.email, full_name: user.full_name });
    res.json({ id: user.id, email: user.email, full_name: user.full_name });
  } catch (error) {
    console.error('Error during signin:', error.stack);
    res.status(500).json({ error: 'Failed to sign in', details: error.message });
  }
});

app.listen(port, () => console.log(`Server running on port ${port}`));
