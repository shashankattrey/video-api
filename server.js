require('dotenv').config();
const express = require('express');
const {Pool} = require('pg');
const app = express();
const port = process.env.PORT || 3000;

// Debug environment variables
console.log('PORT:', process.env.PORT);
console.log('DATABASE_URL:', process.env.DATABASE_URL);

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

// Test database connection
pool.connect((err, client, release) => {
  if (err) {
    console.error('Database connection failed:', err.stack);
    return;
  }
  console.log('Database connection successful');
  release();
});

app.use(express.json());

app.get('/api/videos', async (req, res) => {
  const {section, limit} = req.query;
  try {
    const query = {
      text: 'SELECT * FROM videos WHERE section = $1 LIMIT $2',
      values: [section, limit || 10],
    };
    if (!section) {
      query.text = 'SELECT * FROM videos LIMIT $1';
      query.values = [limit || 1000];
    }
    const result = await pool.query(query);
    console.log('Videos returned:', result.rows); // Add this line
    res.json(result.rows);
  } catch (err) {
    console.error(err.stack);
    res.status(500).send('Server Error');
  }
});

app.post('/api/users', async (req, res) => {
  const {
    google_id,
    email,
    given_name,
    family_name,
    full_name,
    photo_url,
    id_token,
  } = req.body;
  if (
    !google_id ||
    !email ||
    !given_name ||
    !family_name ||
    !full_name ||
    !id_token
  ) {
    return res.status(400).json({
      error: 'Missing required fields',
      details: {
        google_id: !!google_id,
        email: !!email,
        given_name: !!given_name,
        family_name: !!family_name,
        full_name: !!full_name,
        id_token: !!id_token,
      },
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
    const values = [
      google_id,
      email,
      given_name,
      family_name,
      full_name,
      photo_url || null,
      id_token,
    ];
    const result = await pool.query(query, values);
    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error('Error storing user:', error);
    res
      .status(500)
      .json({error: 'Failed to store user', details: error.message});
  }
});

app.listen(port, () => console.log(`Server running on port ${port}`));
