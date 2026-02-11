const express = require("express");
const session = require("express-session");
//destructuring the pool property to create an object
const { Pool } = require("pg");
//used for providing the path to the public
const path = require("path");

const multer = require("multer");
const XLSX = require("xlsx");
const upload = multer({ storage: multer.memoryStorage() });

const app = express();

app.use(express.json());

app.use(session({
  secret: "local_rbac_secret",
  resave: false,
  saveUninitialized: false
}));

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

function parseXls(buffer) {
  const workbook = XLSX.read(buffer, { type: "buffer" });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];

  return XLSX.utils.sheet_to_json(sheet, { defval: 0 });
}



//##change

function mapRow(xlsRow, baseDate) {
  return {
    codigo: xlsRow["Código da Conta"],
    descricao: xlsRow["Nome da Conta"],
    ccusto: xlsRow["CodigoCentroDeCusto"],
    //Uploading debito always negative and credito always positive
    debito: -Math.abs(Number(xlsRow["Saldo Débito"]) || 0),
    credito: Math.abs(Number(xlsRow["Saldo Credito"]) || 0),
    /* Uploading the value as it is originally
    debito: Number(xlsRow["Saldo Débito"]) || 0,
    credito: Number(xlsRow["Saldo Credito"]) || 0,
    */
    mes: baseDate
  };
}

function requireAuth(req, res, next) {
  if (!req.session.user)
    return res.status(401).json({ error: "Not authenticated" });
  next();
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!roles.includes(req.session.user.role))
      return res.status(403).json({ error: "Forbidden" });
    next();
  };
}

app.post(
  "/api/upload-transacoes",
  requireAuth,
  requireRole("admin"),
  upload.array("files", 2),
  async (req, res) => {
    const { month } = req.body;
    const files = req.files;

    if (!month) {
      return res.status(400).send("Mês não informado");
    }

    if (!files || files.length === 0) {
      return res.status(400).send("Nenhum arquivo enviado");
    }

    // month = "2025-12"
    const [year, monthNum] = month.split("-");
    const baseDate = new Date(year, monthNum - 1, 1);

    const client = await pool.connect();

    try {
      await client.query("BEGIN");

      // 🔥 Delete ALL data for this month
      await client.query(
        `
        DELETE FROM transacoes
        WHERE EXTRACT(YEAR FROM mes) = $1
          AND EXTRACT(MONTH FROM mes) = $2
        `,
        [year, monthNum]
      );

      let inserted = 0;

      for (const file of files) {
        const rows = parseXls(file.buffer);

        for (const xlsRow of rows) {
          const row = mapRow(xlsRow, baseDate);

          await client.query(
            `
            INSERT INTO transacoes
              (codigo, descricao, ccusto, debito, credito, mes)
            VALUES
              ($1, $2, $3, $4, $5, $6)
            `,
            [
              row.codigo,
              row.descricao,
              row.ccusto,
              row.debito,
              row.credito,
              row.mes
            ]
          );

          inserted++;
        }
      }

      await client.query("COMMIT");

      res.send(
        `Upload concluído. ${inserted} registros inseridos para ${month}`
      );
    } catch (err) {
      await client.query("ROLLBACK");
      console.error(err);
      res.status(500).send("Erro ao processar upload");
    } finally {
      client.release();
    }
  }
);

//##change

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

app.post("/api/login", async (req, res) => {
  const { login, senha } = req.body;

  const { rows } = await pool.query(
    "SELECT id, login, senha, nome, funcao FROM usuarios WHERE login = $1",
    [login]
  );

  if (rows.length === 0)
    return res.status(401).json({ error: "Usuário não encontrado" });

  const user = rows[0];

  if (user.senha !== senha)
    return res.status(401).json({ error: "Senha inválida" });

  req.session.user = {
    id: user.id,
    login: user.login,
    nome: user.nome,
    role: user.funcao
  };

  res.json({ ok: true });
});

app.get("/api/me", (req, res) => {
  res.json(req.session.user || null);
});

app.get("/api/accounts", async (req, res) => {
  let owner = req.query.owner;

  if (req.session.user?.role === "gerente") {
    owner = req.session.user.nome;
  }

  try {
    let query;
    let params = [];

    if (!owner) {
      // ✅ Todos os gerentes → all accounts
      query = `
        SELECT ccusto
        FROM centro_de_custo
        WHERE ccusto IS NOT NULL
        ORDER BY ccusto;
      `;
    } else {
      // ✅ Filter by gerente
      query = `
        SELECT DISTINCT c.ccusto
        FROM gerentes_ccustos gc
        JOIN usuarios u ON u.id = gc.usuario_id
        JOIN centro_de_custo c ON c.id = gc.ccusto_id
        WHERE u.nome = $1
          AND c.ccusto IS NOT NULL
        ORDER BY c.ccusto;
      `;
      params.push(owner);
    }

    const { rows } = await pool.query(query, params);
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).send("Error fetching accounts");
  }
});



//Overview

app.get("/api/yearly-overview", async (req, res) => {
  try {
    let owner =
      req.query.owner && req.query.owner.trim() !== ""
        ? req.query.owner
        : null;

    if (req.session.user?.role === "gerente") {
      owner = req.session.user.nome;
    }

    const account =
      req.query.account && req.query.account.trim() !== ""
        ? req.query.account
        : null;

    const query = `
      WITH tx AS (
        SELECT
          EXTRACT(YEAR FROM t.mes) AS ano,
          SUM(t.debito + t.credito) AS total,
          c.titulo,
          c.topico,
          c.ordem_titulo
        FROM transacoes t
        JOIN codigos co ON co.codigo = t.codigo
        JOIN categorias c ON c.id = co.id_da_categoria
        WHERE
          ($1::text IS NULL OR t.ccusto = $1)
          AND (
            $2::text IS NULL OR EXISTS (
              SELECT 1
              FROM gerentes_ccustos gc
              JOIN usuarios u        ON u.id = gc.usuario_id
              JOIN centro_de_custo c ON c.id = gc.ccusto_id
              WHERE c.ccusto = t.ccusto
                AND u.nome   = $2
            )
          )
        GROUP BY ano, c.titulo, c.topico, c.ordem_titulo
      )
      SELECT
        titulo,
        topico,
        ano,
        total
      FROM tx
      WHERE ano IS NOT NULL
      ORDER BY ordem_titulo, topico, ano;
    `;

    const { rows } = await pool.query(query, [account, owner]);

    // ---------- shape ----------
    const result = {};
    const yearsSet = new Set();

    for (const r of rows) {
      if (!result[r.topico]) result[r.topico] = {titulo: r.titulo};
      result[r.topico][r.ano] = Number(r.total);
      yearsSet.add(r.ano);
    }

    res.json({
      years: Array.from(yearsSet).sort(),
      data: result
    });
  } catch (err) {
    console.error(err);
    res.status(500).send("Error fetching yearly overview");
  }
});





//By year
app.get("/api/monthly-profit", async (req, res) => {
//console.log("QUERY PARAMS:", req.query);
  try {
    let owner =
      req.query.owner && req.query.owner.trim() !== ""
        ? req.query.owner
        : null;

    if (req.session.user?.role === "gerente") {
      owner = req.session.user.nome;
    }

    const account =
      req.query.account && req.query.account.trim() !== ""
        ? req.query.account
        : null;

    const query = `
      WITH tx AS (
  SELECT 
      t.codigo,
      t.ccusto,
      EXTRACT(YEAR  FROM t.mes)  AS ano,
      EXTRACT(MONTH FROM t.mes) AS mes,
      SUM(t.debito + t.credito) AS total
  FROM transacoes t
  WHERE
    ($1::text IS NULL OR t.ccusto = $1)
    AND (
      $2::text IS NULL OR EXISTS (
        SELECT 1
        FROM gerentes_ccustos gc
        JOIN usuarios u        ON u.id = gc.usuario_id
        JOIN centro_de_custo c ON c.id = gc.ccusto_id
        WHERE c.ccusto = t.ccusto
          AND u.nome   = $2
      )
    )
  GROUP BY t.codigo, t.ccusto, ano, mes
)

SELECT 
    tx.ano,
    c.titulo,
    c.topico,
    c.nome_da_categoria AS category_name,
    c.id,

    SUM(CASE WHEN tx.mes = 1  THEN tx.total ELSE 0 END) AS jan,
    SUM(CASE WHEN tx.mes = 2  THEN tx.total ELSE 0 END) AS fev,
    SUM(CASE WHEN tx.mes = 3  THEN tx.total ELSE 0 END) AS mar,
    SUM(CASE WHEN tx.mes = 4  THEN tx.total ELSE 0 END) AS abr,
    SUM(CASE WHEN tx.mes = 5  THEN tx.total ELSE 0 END) AS mai,
    SUM(CASE WHEN tx.mes = 6  THEN tx.total ELSE 0 END) AS jun,
    SUM(CASE WHEN tx.mes = 7  THEN tx.total ELSE 0 END) AS jul,
    SUM(CASE WHEN tx.mes = 8  THEN tx.total ELSE 0 END) AS ago,
    SUM(CASE WHEN tx.mes = 9  THEN tx.total ELSE 0 END) AS set,
    SUM(CASE WHEN tx.mes = 10 THEN tx.total ELSE 0 END) AS out,
    SUM(CASE WHEN tx.mes = 11 THEN tx.total ELSE 0 END) AS nov,
    SUM(CASE WHEN tx.mes = 12 THEN tx.total ELSE 0 END) AS dez

FROM categorias c
LEFT JOIN codigos co ON co.id_da_categoria = c.id
LEFT JOIN tx        ON tx.codigo = co.codigo


GROUP BY
    tx.ano,
    c.titulo,
    c.topico,
    c.nome_da_categoria,
    c.id

ORDER BY
    tx.ano,
    c.ordem_titulo,
    c.titulo,
    c.topico,
    c.id;
    `;

    /*
    const params = [account];
    const result = await pool.query(query, params);
    res.json(result.rows);
    */

     const { rows } = await pool.query(query, [account, owner]);


    const result = {};

    for (const row of rows) {
      const year = row.ano;
      //If the object with the current year doesn't exist, create it
      if (!result[year]) result[year] = {};
      //If the current topic doesn't exist, create the topic
      if (!result[year][row.topico]) {
        result[year][row.topico] = {
          titulo: row.titulo,
          totals: {
            jan: 0, fev: 0, mar: 0, abr: 0, mai: 0, jun: 0,
            jul: 0, ago: 0, set: 0, out: 0, nov: 0, dez: 0
          },
          categories: []
        };
      }

      //result[anoAtual][topicoAtual].keysDoObjetoTotal("jan", "fev"...)
      for (const m in result[year][row.topico].totals) {
        //m = "jan"  totals.jan += Number(row.jan)
        result[year][row.topico].totals[m] += Number(row[m]);
      }
      //add the current row (ano, topico, category_name...) to the categories array
      result[year][row.topico].categories.push(row);
    }

    res.json(result);
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

app.get("/api/owners", requireAuth, async (req, res) => {
  try {

    // 🔒 Manager can only see himself
    if (req.session.user.role === "gerente") {
      return res.json([
        { nome: req.session.user.nome }
      ]);
    }

    // Admin & Diretor see all gerentes
    const { rows } = await pool.query(`
      SELECT id, nome
      FROM usuarios
      WHERE funcao = 'gerente'
      ORDER BY nome;
    `);

    res.json(rows);

  } catch (err) {
    console.error("Error fetching owners:", err);
    res.status(500).send("Error fetching owners");
  }
});

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