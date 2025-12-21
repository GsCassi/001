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

app.get("/api/accounts", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT DISTINCT ccusto
      FROM transacoes
      WHERE ccusto IS NOT NULL
      ORDER BY ccusto;
    `);

    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).send("Error fetching accounts");
  }
});

app.get("/api/monthly-profit", async (req, res) => {
  try {
    const account = req.query.account || null;

    const query = `
      WITH tx AS (
          SELECT 
              codigo,
              ccusto,
              EXTRACT(MONTH FROM mes) AS mes,
              SUM(debito + credito) AS total
          FROM transacoes
          GROUP BY codigo, ccusto, mes
      )

      SELECT 
          c.topico,
          c.nome_da_categoria AS category_name,

          SUM(CASE WHEN tx.mes = 1 THEN tx.total ELSE 0 END) AS jan,
          SUM(CASE WHEN tx.mes = 2 THEN tx.total ELSE 0 END) AS fev,
          SUM(CASE WHEN tx.mes = 3 THEN tx.total ELSE 0 END) AS mar,
          SUM(CASE WHEN tx.mes = 4 THEN tx.total ELSE 0 END) AS abr,
          SUM(CASE WHEN tx.mes = 5 THEN tx.total ELSE 0 END) AS mai,
          SUM(CASE WHEN tx.mes = 6 THEN tx.total ELSE 0 END) AS jun,
          SUM(CASE WHEN tx.mes = 7 THEN tx.total ELSE 0 END) AS jul,
          SUM(CASE WHEN tx.mes = 8 THEN tx.total ELSE 0 END) AS ago,
          SUM(CASE WHEN tx.mes = 9 THEN tx.total ELSE 0 END) AS set,
          SUM(CASE WHEN tx.mes = 10 THEN tx.total ELSE 0 END) AS out,
          SUM(CASE WHEN tx.mes = 11 THEN tx.total ELSE 0 END) AS nov,
          SUM(CASE WHEN tx.mes = 12 THEN tx.total ELSE 0 END) AS dez

      FROM categorias c
      LEFT JOIN codigos co ON co.id_da_categoria = c.id
      LEFT JOIN tx ON tx.codigo = co.codigo
          AND ($1::text IS NULL OR tx.ccusto = $1::text)

      GROUP BY c.topico, c.nome_da_categoria
      ORDER BY c.topico, c.nome_da_categoria;
    `;

    /*
    const params = [account];
    const result = await pool.query(query, params);
    res.json(result.rows);
    */

     const { rows } = await pool.query(query, [account]);

    /* =========================
       GROUPING + TOTALS
       ========================= */

    const topics = {};

    for (const row of rows) {
      if (!topics[row.topico]) {
        topics[row.topico] = {
          totals: {
            jan: 0, fev: 0, mar: 0, abr: 0, mai: 0, jun: 0,
            jul: 0, ago: 0, set: 0, out: 0, nov: 0, dez: 0
          },
          categories: []
        };
      }

      // accumulate totals
      for (const m of Object.keys(topics[row.topico].totals)) {
        topics[row.topico].totals[m] += Number(row[m]);
      }

      // store full category row
      topics[row.topico].categories.push(row);
    }

    res.json(topics);
  } catch (err) {
    console.error(err);
    res.status(500).send("Server error fetching data");
  }
});

/*
app.get("/api/categories-profit", async (req, res) => {
  try {

    //query string
    const account = req.query.account;
    const params = [account || null];

    const query = `

    WITH tx_by_code AS (
      SELECT
        codigo,
        ccusto,
        SUM(debito + credito) AS total_per_code
      FROM transacoes
      GROUP BY codigo, ccusto
    )
    SELECT
      c.id AS id_da_categoria,
      c.nome_da_categoria AS categoria,
      c.topico,
      COALESCE(SUM(tx.total_per_code), 0) AS profit
    FROM categorias c
    LEFT JOIN codigos co        ON co.id_da_categoria = c.id
    LEFT JOIN tx_by_code tx   ON tx.codigo = co.codigo
    WHERE ($1::text IS NULL OR tx.ccusto = $1::text)
    GROUP BY c.id, c.nome_da_categoria, c.topico
    ORDER BY c.topico, c.id;
    `;

    const result = await pool.query(query, params);

    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).send("Error fetching products");
  }
});
*/
//serve regardless of index.html
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
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