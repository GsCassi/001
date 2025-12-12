const express = require("express");
//destructuring the pool property to create an object
const { Pool } = require("pg");
//used for providing the path to the public
const path = require("path");

const app = express();

// PostgreSQL connection
const pool = new Pool({
  user: "postgres",       // your pg username
  host: "localhost",
  database: "relatorio001",  // database you created
  password: "root",
  port: 5432
});

// Serve static files (HTML)
app.use(express.static(path.join(__dirname, "public")));


// API route to fetch data; app.get will be triggered by the fetch on the html. /api/products
//is the url path that will trigger the function

/*app.get("/api/products", async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM products LIMIT 20");
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).send("Error fetching products");
  }
});
*/


app.get("/api/categories-profit", async (req, res) => {
  try {
    const query = `

    WITH tx_by_code AS (
      SELECT
        codigo,
        SUM(debito + credito) AS total_per_code
      FROM transacoes
      GROUP BY codigo
    )
    SELECT
      c.id AS id_da_categoria,
      c.nome_da_categoria AS categoria,
      COALESCE(SUM(tx.total_per_code), 0) AS profit
    FROM categorias c
    LEFT JOIN codigos co        ON co.id_da_categoria = c.id
    LEFT JOIN tx_by_code tx   ON tx.codigo = co.codigo
    GROUP BY c.id, c.nome_da_categoria
    ORDER BY c.id;
    `;

    const result = await pool.query(query);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).send("Error fetching products");
  }
});

// Start server and listen for requests
app.listen(3000, () => {
  console.log("Server running at http://localhost:3000");
});

pool.query("SELECT NOW()", (err, result) => {
  if (err) {
    console.error("Database connection failed:", err);
  } else {
    console.log("Connected! Server time is:", result.rows[0]);
  }
});

/* TO BE STUDIED
process.on("SIGINT", async () => {
  await pool.end();
  console.log("Database pool closed. Server shutting down.");
  process.exit(0);
});*/