require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const redis = require('redis');
const bcrypt = require('bcrypt');
const app = express();
const port = process.env.PORT || 3000;

console.log('PORT:', process.env.PORT);
console.log('DATABASE_URL:', process.env.DATABASE_URL);
console.log('REDIS_URL:', process.env.REDIS_URL);

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

pool.connect((err, client, release) => {
  if (err) {
    console.error('Database connection failed:', err.stack);
    return;
  }
  console.log('Database connection successful');
  release();
});

const redisClient = redis.createClient({
  url: process.env.REDIS_URL,
});
redisClient.on('error', err => console.error('Redis error:', err.message, err.stack));
redisClient.on('connect', () => console.log('Redis connected'));
redisClient.on('ready', () => console.log('Redis ready'));
redisClient.on('end', () => console.log('Redis connection ended'));
redisClient.connect().catch(err => console.error('Redis connection failed:', err.message, err.stack));

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

// Google Sign-In endpoint
app.post('/api/users', async (req, res) => {
  const { google_id, email, given_name, family_name, full_name, photo_url, id_token } = req.body;
  if (!google_id || !email || !given_name || !family_name || !full_name || !id_token) {
    return res.status(400).json({
      error: 'Missing required fields for Google Sign-In',
      details: { google_id: !!google_id, email: !!email, given_name: !!given_name, family_name: !!family_name, full_name: !!full_name, id_token: !!id_token },
    });
  }
  try {
    const query = `
      INSERT INTO users (google_id, email, given_name, family_name, full_name, photo_url, id_token)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      ON CONFLICT (google_id)
      DO UPDATE SET
        email = EXCLUDED.email,
        given_name = EXCLUDED.given_name,
        family_name = EXCLUDED.family_name,
        full_name = EXCLUDED.full_name,
        photo_url = EXCLUDED.photo_url,
        id_token = EXCLUDED.id_token,
        updated_at = CURRENT_TIMESTAMP
      RETURNING *;
    `;
    const values = [google_id, email, given_name, family_name, full_name, photo_url || null, id_token];
    const result = await pool.query(query, values);
    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error('Error storing Google user:', error);
    res.status(500).json({ error: 'Failed to store user', details: error.message });
  }
});

// Sign-up with Email/Password
app.post('/api/signup', async (req, res) => {
  const { email, password, full_name } = req.body;
  if (!email || !password || !full_name) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  try {
    const hashedPassword = await bcrypt.hash(password, 10);
    const query = `
      INSERT INTO users (email, password, full_name)
      VALUES ($1, $2, $3)
      ON CONFLICT (email)
      DO NOTHING
      RETURNING *;
    `;
    const values = [email, hashedPassword, full_name];
    const result = await pool.query(query, values);

    if (!result.rows.length) {
      return res.status(409).json({ error: 'Email already exists' });
    }

    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error('Error during signup:', error);
    res.status(500).json({ error: 'Failed to sign up', details: error.message });
  }
});

// Sign-in with Email/Password
app.post('/api/signin', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'Missing email or password' });
  }

  try {
    const query = 'SELECT * FROM users WHERE email = $1';
    const result = await pool.query(query, [email]);

    if (!result.rows.length) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const user = result.rows[0];
    const isMatch = await bcrypt.compare(password, user.password || '');
    if (!isMatch) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    res.json({ id: user.id, email: user.email, full_name: user.full_name });
  } catch (error) {
    console.error('Error during signin:', error);
    res.status(500).json({ error: 'Failed to sign in', details: error.message });
  }
});

app.listen(port, () => console.log(`Server running on port ${port}`));
