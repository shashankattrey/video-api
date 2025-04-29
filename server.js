require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const redis = require('redis');
const app = express();
const port = process.env.PORT || 3000;

// Validate environment variables
const requiredEnvVars = ['DATABASE_URL', 'REDIS_URL'];
requiredEnvVars.forEach((varName) => {
  if (!process.env[varName]) {
    console.error(`Error: Missing required environment variable ${varName}`);
    process.exit(1);
  }
});

console.log('PORT:', process.env.PORT);
console.log('DATABASE_URL:', process.env.DATABASE_URL);
console.log('REDIS_URL:', process.env.REDIS_URL);

// Database connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
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
redisClient.on('error', (err) => console.error('Redis error:', err.message));
redisClient.on('connect', () => console.log('Redis connected'));
redisClient.on('ready', () => console.log('Redis ready'));
redisClient.on('end', () => console.log('Redis connection ended'));

(async () => {
  try {
    await redisClient.connect();
  } catch (err) {
    console.error('Redis connection failed:', err.message);
  }
})();

app.use(express.json());

// Generate unique referral code starting with BGSHWR
const generateReferralCode = async () => {
  let code;
  let exists;
  do {
    const randomNumber = Math.floor(100000 + Math.random() * 900000); // 6-digit number
    code = `BGSHWR${randomNumber}`;
    const result = await pool.query('SELECT 1 FROM users WHERE referral_code = $1', [code]);
    exists = result.rows.length > 0;
  } while (exists);
  return code;
};

// Health check
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'OK', timestamp: new Date().toISOString() });
});

// Videos endpoint (unchanged)
app.get('/api/videos', async (req, res) => {
  const { section, limit = 10, offset = 0 } = req.query;
  const parsedLimit = Math.max(1, Math.min(100, parseInt(limit)));
  const parsedOffset = Math.max(0, parseInt(offset));
  const cacheKey = section ? `videos:${section}:${parsedLimit}:${parsedOffset}` : `videos:all:${parsedLimit}:${parsedOffset}`;

  try {
    const cachedData = await redisClient.get(cacheKey);
    if (cachedData) {
      console.log(`Cache hit for ${cacheKey}`);
      return res.json(JSON.parse(cachedData));
    }

    let query = section
      ? { text: 'SELECT * FROM videos WHERE section = $1 ORDER BY created_at DESC LIMIT $2 OFFSET $3', values: [section, parsedLimit, parsedOffset] }
      : { text: 'SELECT * FROM videos ORDER BY created_at DESC LIMIT $1 OFFSET $2', values: [parsedLimit, parsedOffset] };
    
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

// Register device and handle referral
app.post('/api/register-device', async (req, res) => {
  const { device_id, referral_code } = req.body;
  if (!device_id) {
    console.log('Device registration failed: Missing device_id');
    return res.status(400).json({ error: 'Missing device_id' });
  }

  try {
    // Check if device is already registered
    const existingUserQuery = 'SELECT id, coins, referral_code, has_reviewed, share_count FROM users WHERE device_id = $1';
    const existingUserResult = await pool.query(existingUserQuery, [device_id]);
    if (existingUserResult.rows.length) {
      const user = existingUserResult.rows[0];
      const userData = {
        id: user.id,
        device_id,
        coins: user.coins,
        referral_code: user.referral_code,
        referral_url: `bageshwardham://refer?ref=${user.referral_code}`,
        has_reviewed: user.has_reviewed,
        share_count: user.share_count,
      };
      await redisClient.setEx(`user:${user.id}`, 3600, JSON.stringify(userData));
      console.log(`Cached user:${user.id} in Redis`);
      console.log('Device already registered:', userData);
      return res.json(userData);
    }

    // Handle referral logic
    let coins = 0;
    let referredBy = null;
    if (referral_code) {
      const referrerQuery = 'SELECT id, coins FROM users WHERE referral_code = $1';
      const referrerResult = await pool.query(referrerQuery, [referral_code]);
      if (referrerResult.rows.length) {
        const referrer = referrerResult.rows[0];
        referredBy = referral_code;
        coins += 10; // Award 10 coins to new user
        await pool.query('UPDATE users SET coins = coins + 10 WHERE id = $1', [referrer.id]);
        await redisClient.del(`user:${referrer.id}`);
        console.log(`Awarded 10 coins to referrer with ID ${referrer.id}`);
      }
    }

    // Register new device
    const newReferralCode = await generateReferralCode();
    const query = `
      INSERT INTO users (device_id, coins, referral_code, referred_by, has_reviewed, share_count)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING id, device_id, coins, referral_code, has_reviewed, share_count;
    `;
    const values = [device_id, coins, newReferralCode, referredBy, false, 0];
    const result = await pool.query(query, values);

    const user = result.rows[0];
    const userData = {
      id: user.id,
      device_id: user.device_id,
      coins: user.coins,
      referral_code: user.referral_code,
      referral_url: `bageshwardham://refer?ref=${user.referral_code}`,
      has_reviewed: user.has_reviewed,
      share_count: user.share_count,
    };

    await redisClient.setEx(`user:${user.id}`, 3600, JSON.stringify(userData));
    console.log(`Cached user:${user.id} in Redis`);

    console.log('Device registered:', userData);
    res.status(201).json(userData);
  } catch (error) {
    console.error('Error during device registration:', error.stack);
    res.status(500).json({ error: 'Failed to register device', details: error.message });
  }
});

// Get user details
app.get('/api/user/:id', async (req, res) => {
  const { id } = req.params;
  const cacheKey = `user:${id}`;

  try {
    const cachedData = await redisClient.get(cacheKey);
    if (cachedData) {
      console.log(`Cache hit for ${cacheKey}`);
      return res.json(JSON.parse(cachedData));
    }

    const query = 'SELECT id, device_id, coins, referral_code, has_reviewed, share_count FROM users WHERE id = $1';
    const result = await pool.query(query, [id]);
    if (!result.rows.length) {
      console.log(`User not found for ID ${id}`);
      return res.status(404).json({ error: 'User not found' });
    }

    const user = result.rows[0];
    const userData = {
      id: user.id,
      device_id: user.device_id,
      coins: user.coins,
      referral_code: user.referral_code,
      referral_url: `bageshwardham://refer?ref=${user.referral_code}`,
      has_reviewed: user.has_reviewed,
      share_count: user.share_count,
    };

    await redisClient.setEx(cacheKey, 3600, JSON.stringify(userData));
    console.log(`Cached user:${id} in Redis`);
    res.json(userData);
  } catch (error) {
    console.error('Error fetching user:', error.stack);
    res.status(500).json({ error: 'Failed to fetch user', details: error.message });
  }
});

// Record Play Store review initiation and award coins
app.post('/api/submit-review', async (req, res) => {
  const { user_id } = req.body;
  if (!user_id) {
    console.log('Review submission failed: Missing user_id');
    return res.status(400).json({ error: 'Missing user_id' });
  }

  try {
    const userQuery = 'SELECT coins, has_reviewed FROM users WHERE id = $1';
    const userResult = await pool.query(userQuery, [user_id]);
    if (!userResult.rows.length) {
      console.log(`User not found for ID ${user_id}`);
      return res.status(404).json({ error: 'User not found' });
    }

    const user = userResult.rows[0];
    if (user.has_reviewed) {
      console.log(`User ID ${user_id} has already submitted a review`);
      return res.status(400).json({ error: 'User has already submitted a review' });
    }

    const updateQuery = `
      UPDATE users
      SET coins = coins + 50, has_reviewed = TRUE
      WHERE id = $1
      RETURNING id, device_id, coins, referral_code, has_reviewed, share_count;
    `;
    const updateResult = await pool.query(updateQuery, [user_id]);

    const updatedUser = updateResult.rows[0];
    const userData = {
      id: updatedUser.id,
      device_id: updatedUser.device_id,
      coins: updatedUser.coins,
      referral_code: updatedUser.referral_code,
      referral_url: `bageshwardham://refer?ref=${updatedUser.referral_code}`,
      has_reviewed: updatedUser.has_reviewed,
      share_count: updatedUser.share_count,
    };

    await redisClient.del(`user:${user_id}`);
    console.log(`Invalidated cache for user:${user_id}`);

    await redisClient.setEx(`user:${user_id}`, 3600, JSON.stringify(userData));
    console.log(`Cached user:${user_id} in Redis`);

    console.log(`Awarded 50 coins to user ID ${user_id} for Play Store review`);
    res.json(userData);
  } catch (error) {
    console.error('Error during review submission:', error.stack);
    res.status(500).json({ error: 'Failed to submit review', details: error.message });
  }
});

// Record app share and award coins
app.post('/api/share-app', async (req, res) => {
  const { user_id, share_id } = req.body;

  if (!user_id || !share_id) {
    console.log('Share failed: Missing user_id or share_id');
    return res.status(400).json({ error: 'Missing user_id or share_id' });
  }
  if (isNaN(parseInt(user_id))) {
    console.log('Share failed: Invalid user_id format');
    return res.status(400).json({ error: 'Invalid user_id format' });
  }
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!uuidRegex.test(share_id)) {
    console.log('Share failed: Invalid share_id format');
    return res.status(400).json({ error: 'Invalid share_id format' });
  }

  try {
    const userQuery = 'SELECT coins, share_count FROM users WHERE id = $1';
    const userResult = await pool.query(userQuery, [user_id]);
    if (!userResult.rows.length) {
      console.log(`User not found for ID ${user_id}`);
      return res.status(404).json({ error: 'User not found' });
    }

    const shareCheckQuery = 'SELECT 1 FROM shares WHERE user_id = $1 AND share_id = $2';
    const shareCheckResult = await pool.query(shareCheckQuery, [user_id, share_id]);
    if (shareCheckResult.rows.length) {
      console.log(`Duplicate share detected for user ID ${user_id}, share_id ${share_id}`);
      return res.status(400).json({ error: 'Share already recorded' });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const shareQuery = `
        INSERT INTO shares (user_id, share_id)
        VALUES ($1, $2)
        RETURNING id;
      `;
      await client.query(shareQuery, [user_id, share_id]);
      const updateQuery = `
        UPDATE users
        SET coins = coins + 10, share_count = share_count + 1
        WHERE id = $1
        RETURNING id, device_id, coins, referral_code, has_reviewed, share_count;
      `;
      const updateResult = await client.query(updateQuery, [user_id]);
      await client.query('COMMIT');

      const updatedUser = updateResult.rows[0];
      const userData = {
        id: updatedUser.id,
        device_id: updatedUser.device_id,
        coins: updatedUser.coins,
        referral_code: updatedUser.referral_code,
        referral_url: `bageshwardham://refer?ref=${updatedUser.referral_code}`,
        has_reviewed: updatedUser.has_reviewed,
        share_count: updatedUser.share_count,
      };

      console.log(`Recorded share for user ID ${user_id}, share_id ${share_id}`);
      console.log(`Awarded 10 coins to user ID ${user_id} for app share`);
      res.json(userData);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  } catch (error) {
    console.error('Error during app share:', error.stack);
    const errorMessage = process.env.NODE_ENV === 'production' ? 'Internal server error' : error.message;
    res.status(500).json({ error: 'Failed to record share', details: errorMessage });
  }
});
app.listen(port, () => console.log(`Server running on port ${port}`));
