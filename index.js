const express = require("express");
const session = require("express-session");
const pgSession = require("connect-pg-simple")(session);
const mysql = require('mysql2/promise');
//destructuring the pool property to create an object
const { Pool } = require("pg");
//used for providing the path to the public
const path = require("path");

const multer = require("multer");
const XLSX = require("xlsx");
const upload = multer({ storage: multer.memoryStorage() });
const MIN_DATE_FILTER = '2022-01-01 00:00:00';

const app = express();

// PostgreSQL connection
const pool = new Pool({
  user: "sige_dbuser",       // your pg username
  host: "postgresql-server-01.marteengenharia.com.br",
  database: "sige",  // database you created
  password: "Adm5.TI@$sige",
  port: 5432
});

// NEW: MySQL connection pool
const mysqlPool = mysql.createPool({
  host: "mysql-server-01.marteengenharia.com.br", // Change to your MySQL host
  user: "dba",      // Change to your MySQL user
  password: "Adm5.TI@$dba", // Change to your MySQL password
  database: "adminis", // Change to your MySQL database
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
});



app.set('trust proxy', 1);

app.use(express.json());

app.use(session({
  store: new pgSession({
    pool : pool,                // Uses your existing Pool connection
    tableName : 'user_sessions', // The table we created in Step 1
    pruneSessionInterval: 60 * 15 // Cleans up expired sessions every 15 minutes
  }),
  secret: "local_rbac_secret",
  resave: false,
  saveUninitialized: false,
  cookie: { 
    maxAge: 1 * 24 * 60 * 60 * 1000, // User stays logged in for 24 hours
    secure: false,                   // Keep false unless you have HTTPS/SSL
    httpOnly: true,                  // Security: prevents JS from reading the cookie
    sameSite: 'lax'                  // Helps modern browsers maintain the session
  }
}));


// Serve static files (HTML)
app.use(express.static(path.join(__dirname, "public")));

function parseXls(buffer) {
  const workbook = XLSX.read(buffer, { type: "buffer" });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];

  return XLSX.utils.sheet_to_json(sheet, { defval: 0 });
}

function parseCurrency(value) {
  if (typeof value === 'number') return value;
  if (typeof value === 'string') {
    // Remove 'R$', spaces, and thousands separators (dots)
    let cleaned = value.replace(/[R$\s\.]/g, '');
    // Change the decimal comma to a decimal dot
    cleaned = cleaned.replace(',', '.');
    return Number(cleaned) || 0;
  }
  return 0;
}

// Helper to fetch allowed cost centers from MySQL using ONLY the login
async function getAllowedCostCenters(login) {
  const query = `
    SELECT DISTINCT RIGHT(p.centroCusto, 6) AS ccusto
    FROM adminis.projetosaht p
    JOIN adminis.usuarioaht u ON p.idGerente = u.id
    WHERE u.login = ?
      AND p.centroCusto IS NOT NULL
      AND p.dataInicio >= '${MIN_DATE_FILTER}'
  `;
  const [rows] = await mysqlPool.execute(query, [login]);
  return rows.map(r => r.ccusto);
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
  upload.array("files", 2), // Keep as 2 to support the "direto" upload which uses 2 files
  async (req, res) => {
    const { month, uploadType } = req.body;
    const files = req.files;

    if (!month) {
      return res.status(400).send("Mês não informado");
    }

    if (!files || files.length === 0) {
      return res.status(400).send("Nenhum arquivo enviado");
    }

    const [year, monthNum] = month.split("-");
    const baseDate = new Date(year, monthNum - 1, 1);

    // ==========================================
    // BRANCH 1: Lançamento Direto (Database Insert)
    // ==========================================
    if (uploadType === "direto") {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");

        // Delete ALL data for this month
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
        return res.send(`Upload concluído. ${inserted} registros inseridos para ${month}`);
      } catch (err) {
        await client.query("ROLLBACK");
        console.error(err);
        return res.status(500).send("Erro ao processar upload");
      } finally {
        client.release();
      }
    }

    // ==========================================
    // BRANCH 2: Gerar Rateio (The Apportionment Engine)
    // ==========================================
    else if (uploadType === "rateio") {
      const pgClient = await pool.connect();
      try {

        // ---------------------------------------------------------
        // STEP 1: FETCH ALL ACTIVE HEADCOUNT (MySQL Unificado - View)
        // ---------------------------------------------------------
        // Notice we are now fetching U_CC_Padrao and U_Folha_Ponto right here!
        const [activeUsersRes] = await mysqlPool.execute(`
              SELECT 
                id, 
                centroCustoPadrao AS U_CC_Padrao, 
                preencheAHT AS U_Folha_Ponto 
              FROM adminis.usuarioaht 
              WHERE ativo = 1
            `);

        const totalHeadcount = activeUsersRes.length;
        console.log(`Total Headcount ativo (MySQL unificado): ${totalHeadcount}`);

        // ---------------------------------------------------------
        // STEP 2: FETCH TIMESHEETS (MySQL)
        // ---------------------------------------------------------
        const [timesheetRes] = await mysqlPool.execute(`
          SELECT 
              idUsuario AS id_usuario,
              centroCusto AS ccusto,
              SUM(horasReaisFracao) AS horas_trabalhadas
          FROM adminis.lancamentosaht
          WHERE YEAR(data) = ? AND MONTH(data) = ?
          GROUP BY idUsuario, centroCusto
        `, [year, monthNum]);

        const userDistribution = {};
        
        timesheetRes.forEach(row => {
          const userId = row.id_usuario;
          const hours = Number(row.horas_trabalhadas);
          
          if (!userDistribution[userId]) {
            userDistribution[userId] = { totalHours: 0, allocations: {} };
          }
          
          userDistribution[userId].totalHours += hours;
          userDistribution[userId].allocations[row.ccusto] = hours;
        });

        // ---------------------------------------------------------
        // STEP 3: THE APPORTIONMENT MATH (Unified)
        // ---------------------------------------------------------
        if (totalHeadcount === 0) {
          return res.status(400).send("Nenhum funcionário ativo encontrado no sistema.");
        }

        const inputRows = parseXls(files[0].buffer);
        const finalOutputRows = [];

        for (const row of inputRows) {
          console.log("Linha lida do Excel:", row);

          const historico = row["Historico"] || row["Histórico"]; 
          const debitoOH = row["Débito OH"];
          const debitoTDOM = row["Débito TD/OM"];
          const credito = row["Credito"] || row["Crédito"];

          // parseCurrency is safely doing its job right here!
          const entradaValor = parseCurrency(row["Entrada de Valor"]);

          if (entradaValor === 0) {
            console.log("⚠️ Linha ignorada: Valor zerado ou inválido.");
            continue;
          }

          const perCapita = entradaValor / totalHeadcount;
          const rowAllocations = {}; 
          
          const addAllocation = (debitoCode, ccusto, amount, userId) => {
            const safeDebito = debitoCode || "N/A";
            const safeCredito = credito || "N/A";
            const safeCcusto = ccusto || "N/A";
            const safeHist = historico || "N/A";
            
            const key = `${safeDebito}|${safeCredito}|${safeCcusto}|${safeHist}`;

            if (!rowAllocations[key]) {
              rowAllocations[key] = { amount: 0, uniqueUsers: new Set() };
            }

            // Add the money and add the person's ID to the count
            rowAllocations[key].amount += amount;
            rowAllocations[key].uniqueUsers.add(userId);
          };

          // ---------------------------------------------------------
          // 4: THE MERGED LOOP - Iterate through all active users
          // ---------------------------------------------------------
          for (const user of activeUsersRes) {
            const userId = user.id;
            
            // Get their default cost center, fallback to 1003OH if missing
            const defaultCcusto = user.U_CC_Padrao || "00011003OH"; 
            
            // Check the new flag! (Using == 1 in case MySQL returns tinyint as a number or boolean)
            const isTimesheetUser = (user.U_Folha_Ponto == 1); 
            
            const userTimesheet = userDistribution[userId];

            // If they are required to submit hours AND they logged more than 0 hours:
            if (isTimesheetUser && userTimesheet && userTimesheet.totalHours > 0) {
              
              for (const [ccusto, hours] of Object.entries(userTimesheet.allocations)) {
                const proportion = hours / userTimesheet.totalHours;
                const valor = perCapita * proportion;
                
                // Check if the specific project they worked on is an OH center
                const isOH = ccusto.toUpperCase().endsWith("OH");
                const currentDebito = isOH ? debitoOH : debitoTDOM;
                
                addAllocation(currentDebito, ccusto, valor, userId);
              }
              
            } else {
              // If they DON'T submit hours (U_Folha_Ponto = 0) OR they submitted 0 hours:
              // Drop their entire slice into their U_CC_Padrao
              
              const isOH = defaultCcusto.toUpperCase().endsWith("OH");
              const currentDebito = isOH ? debitoOH : debitoTDOM;
              
              addAllocation(currentDebito, defaultCcusto, perCapita, userId);
            }
          }

          // Format output rows
          for (const [key, data] of Object.entries(rowAllocations)) {
            const [debito, cred, ccusto, hist] = key.split("|");
            
            finalOutputRows.push({
              "Debito": debito,
              "Credito": cred,
              "Centro de Custo": ccusto,
              "Historico": hist,
              "Qtd Pessoas": data.uniqueUsers.size,
              "Valor": Number(data.amount.toFixed(2)) 
            });
          }
        }

        // STEP 5: GENERATE EXCEL BUFFER
        const newWorkbook = XLSX.utils.book_new();
        const newWorksheet = XLSX.utils.json_to_sheet(finalOutputRows);
        
        XLSX.utils.book_append_sheet(newWorkbook, newWorksheet, "Rateio Processado");

        const excelBuffer = XLSX.write(newWorkbook, { type: 'buffer', bookType: 'xlsx' });

        res.setHeader('Content-Disposition', `attachment; filename="Rateio_Processado_${month}.xlsx"`);
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        
        return res.send(excelBuffer);

      } catch (err) {
        console.error("Erro no processamento do rateio:", err);
        return res.status(500).send("Erro interno ao processar o rateio");
      } finally {
        pgClient.release();
      }
    } 
    
    // Fallback if uploadType is missing or weird
    else {
      return res.status(400).send("Tipo de upload inválido.");
    }
  }
);


// ---------------------------------------------------------
// GET: Fetch programs for the frontend modal
// ---------------------------------------------------------
app.get("/api/programas", requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query("SELECT id, nome_programa FROM programas ORDER BY nome_programa");
    res.json(rows);
  } catch (err) {
    console.error("Error fetching programs:", err);
    res.status(500).send("Erro ao buscar programas");
  }
});

// ---------------------------------------------------------
// RATEIO DE PROGRAMAS (Activity-Based Costing)
// ---------------------------------------------------------
app.post("/api/rateio-programas", requireAuth, requireRole("admin"), async (req, res) => {
  const { month, programas } = req.body;

  if (!month || !programas || programas.length === 0) {
    return res.status(400).send("Mês ou programas não informados.");
  }

  const [year, monthNum] = month.split("-");
  const pgClient = await pool.connect();

  try {
    // 1. FETCH ALL ACTIVE USERS (MySQL View) 
    // Now including idOrganograma to match against our rules
    const [activeUsersRes] = await mysqlPool.execute(`
      SELECT id, centroCustoPadrao AS U_CC_Padrao, preencheAHT AS U_Folha_Ponto, idOrganograma 
      FROM adminis.usuarioaht 
      WHERE ativo = 1
    `);

    // 2. FETCH TIMESHEETS (MySQL)
    const [timesheetRes] = await mysqlPool.execute(`
      SELECT 
          idUsuario AS id_usuario,
          centroCusto AS ccusto,
          SUM(horasReaisFracao) AS horas_trabalhadas
      FROM adminis.lancamentosaht
      WHERE YEAR(data) = ? AND MONTH(data) = ?
      GROUP BY idUsuario, centroCusto
    `, [year, monthNum]);

    const userDistribution = {};
    timesheetRes.forEach(row => {
      const userId = row.id_usuario;
      const hours = Number(row.horas_trabalhadas);
      if (!userDistribution[userId]) {
        userDistribution[userId] = { totalHours: 0, allocations: {} };
      }
      userDistribution[userId].totalHours += hours;
      userDistribution[userId].allocations[row.ccusto] = hours;
    });

    // 3. FETCH POSTGRESQL MAPPING & TARGETING RULES
    // Get the Area Classifications
    const organogramaRes = await pgClient.query(`SELECT id_organograma, classificacao FROM organograma_classes`);
    const classMap = {};
    organogramaRes.rows.forEach(r => classMap[r.id_organograma] = r.classificacao);

    // Build the user map and dynamically attach their classification
    const activeUsersMap = {};
    activeUsersRes.forEach(u => {
      u.classificacao = classMap[u.idOrganograma] || 'TD'; // Fallback just in case
      activeUsersMap[u.id] = u;
    });

    // Get all assigned targeting rules for the programs
    const usersLinkRes = await pgClient.query(`SELECT id_programa, id_usuario_mysql FROM programa_usuarios`);
    const areasLinkRes = await pgClient.query(`SELECT id_programa, id_organograma FROM programa_areas`);
    const tiposLinkRes = await pgClient.query(`SELECT id_programa, classificacao FROM programa_tipos`);

    // Organize the rules by program ID
    const progRules = {};
    programas.forEach(p => {
      progRules[p.id] = { users: [], areas: [], tipos: [] };
    });

    usersLinkRes.rows.forEach(row => { if(progRules[row.id_programa]) progRules[row.id_programa].users.push(row.id_usuario_mysql); });
    areasLinkRes.rows.forEach(row => { if(progRules[row.id_programa]) progRules[row.id_programa].areas.push(row.id_organograma); });
    tiposLinkRes.rows.forEach(row => { if(progRules[row.id_programa]) progRules[row.id_programa].tipos.push(row.classificacao); });


    // 4. THE APPORTIONMENT MATH (Iterating per Program)
    const finalOutputRows = [];

    for (const prog of programas) {
      const progId = prog.id;
      const progName = prog.nome;
      const totalValor = Number(prog.valor);

      if (totalValor <= 0) continue; 

      const rules = progRules[progId];
      const uniqueUserIds = new Set(); // Using a Set to deduplicate automatically

      // Target Match A: Individual Users
      rules.users.forEach(userId => {
        if (activeUsersMap[userId]) uniqueUserIds.add(userId);
      });

      // Target Match B & C: Areas and Classifications
      activeUsersRes.forEach(user => {
        if (rules.areas.includes(user.idOrganograma) || rules.tipos.includes(user.classificacao)) {
          uniqueUserIds.add(user.id);
        }
      });

      const headcount = uniqueUserIds.size;

      if (headcount === 0) {
        console.log(`⚠️ Ignorando ${progName}: Nenhum alvo ativo vinculado às regras.`);
        continue;
      }

      const perCapita = totalValor / headcount;
      const programAllocations = {}; 

      const addAllocation = (ccusto, amount) => {
        const safeCcusto = ccusto || "N/A";
        programAllocations[safeCcusto] = (programAllocations[safeCcusto] || 0) + amount;
      };

      // Loop through the clean, deduplicated pool of users
      for (const userId of uniqueUserIds) {
        const user = activeUsersMap[userId];
        const defaultCcusto = user.U_CC_Padrao || "00011003OH";
        const isTimesheetUser = (user.U_Folha_Ponto == 1);
        const userTimesheet = userDistribution[userId];

        if (isTimesheetUser && userTimesheet && userTimesheet.totalHours > 0) {
          for (const [ccusto, hours] of Object.entries(userTimesheet.allocations)) {
            const proportion = hours / userTimesheet.totalHours;
            addAllocation(ccusto, perCapita * proportion);
          }
        } else {
          // Zero hours or not required to submit hours -> Dump into default CC
          addAllocation(defaultCcusto, perCapita);
        }
      }

      // Format output rows for Excel
      for (const [ccusto, amount] of Object.entries(programAllocations)) {
        finalOutputRows.push({
          "Programa": progName,
          "Centro de Custo": ccusto,
          "Valor Total": totalValor,
          "Valor Rateado": Number(amount.toFixed(2))
        });
      }
    }

    if (finalOutputRows.length === 0) {
      return res.status(400).send("Nenhum rateio gerado. Verifique as regras de distribuição e os valores.");
    }

    // 5. GENERATE THE NEW EXCEL FILE
    const newWorkbook = XLSX.utils.book_new();
    const newWorksheet = XLSX.utils.json_to_sheet(finalOutputRows);
    XLSX.utils.book_append_sheet(newWorkbook, newWorksheet, "Rateio Softwares");

    const excelBuffer = XLSX.write(newWorkbook, { type: 'buffer', bookType: 'xlsx' });

    res.setHeader('Content-Disposition', `attachment; filename="Rateio_Programas_${month}.xlsx"`);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    
    return res.send(excelBuffer);

  } catch (err) {
    console.error("Erro no rateio de programas:", err);
    return res.status(500).send("Erro interno ao processar o rateio de softwares.");
  } finally {
    pgClient.release();
  }
});
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

  // --- SIMPLE ACCESS LOG ---
  try {
    // PostgreSQL will automatically stamp it with the current date/time
    await pool.query(
      "INSERT INTO login_logs (login, nome) VALUES ($1, $2)",
      [user.login, user.nome]
    );
  } catch (logErr) {
    console.error("Erro ao registrar log de acesso:", logErr);
  }
  // ------------------------------

  res.json({ ok: true });
});

app.post("/api/logout", (req, res) => {
  req.session.destroy(err => {
    if (err) {
      console.error("Logout error:", err);
      return res.status(500).send("Erro ao sair");
    }

    res.clearCookie("connect.sid"); // removes session cookie
    res.sendStatus(200);
  });
});

app.get("/api/me", (req, res) => {
  res.json(req.session.user || null);
});

app.get("/api/accounts", requireAuth, async (req, res) => {
  let targetLogin = req.query.owner;
  if (req.session.user?.role === "gerente") targetLogin = req.session.user.login; 

  try {
    let query, params = [];
    if (!targetLogin) {
      query = `
        SELECT DISTINCT RIGHT(centroCusto, 6) AS ccusto
        FROM adminis.projetosaht
        WHERE centroCusto IS NOT NULL
          AND dataInicio >= '${MIN_DATE_FILTER}'
        ORDER BY ccusto;
      `;
    } else {
      query = `
        SELECT DISTINCT RIGHT(p.centroCusto, 6) AS ccusto
        FROM adminis.projetosaht p
        JOIN adminis.usuarioaht u ON p.idGerente = u.id
        WHERE u.login = ? 
          AND p.centroCusto IS NOT NULL
          AND p.dataInicio >= '${MIN_DATE_FILTER}'
        ORDER BY ccusto;
      `;
      params.push(targetLogin);
    }
    const [rows] = await mysqlPool.execute(query, params);
    res.json(rows);
  } catch (err) {
    console.error("Error fetching accounts:", err);
    res.status(500).send("Error fetching accounts");
  }
});

app.get("/api/client-hours", requireAuth, async (req, res) => {
  const account = req.query.account;
  
  if (!account) return res.json(null);

  try {
    const query = `
      WITH HorasConsumidas AS (
          SELECT 
              l.idContrato,
              SUM(
                  CASE 
                      WHEN DAY(CURRENT_DATE) >= 6 AND l.data < DATE_FORMAT(CURRENT_DATE, '%Y-%m-01') 
                      THEN l.horasPadrao 
                      WHEN DAY(CURRENT_DATE) < 6 AND l.data < DATE_FORMAT(CURRENT_DATE - INTERVAL 1 MONTH, '%Y-%m-01') 
                      THEN l.horasPadrao 
                      ELSE 0 
                  END
              ) AS total_horas_lancadas,
              SUM(
                  CASE 
                      WHEN DAY(CURRENT_DATE) >= 6 
                           AND YEAR(l.data) = YEAR(CURRENT_DATE - INTERVAL 1 MONTH) 
                           AND MONTH(l.data) = MONTH(CURRENT_DATE - INTERVAL 1 MONTH) 
                      THEN l.horasPadrao 
                      WHEN DAY(CURRENT_DATE) < 6
                           AND YEAR(l.data) = YEAR(CURRENT_DATE - INTERVAL 2 MONTH) 
                           AND MONTH(l.data) = MONTH(CURRENT_DATE - INTERVAL 2 MONTH) 
                      THEN l.horasPadrao 
                      ELSE 0 
                  END
              ) AS horas_mes_passado
          FROM adminis.lancamentosaht l
          WHERE l.idContrato IN (SELECT id FROM adminis.projetosaht WHERE RIGHT(centroCusto, 6) = ?)
          GROUP BY l.idContrato
      ),
      OrcamentoContrato AS (
          SELECT 
              p.idContrato,
              SUM(p.horaPadraoPlanejada) AS horas_totais_orcadas
          FROM adminis.planejadoaht p
          WHERE p.idContrato IN (SELECT id FROM adminis.projetosaht WHERE RIGHT(centroCusto, 6) = ?)
          GROUP BY p.idContrato 
      )
      SELECT 
          proj.centroCusto AS Ct_Centro_Custo, 
          proj.nomeCliente AS Cl_Nome,
          TRUNCATE(COALESCE(oc.horas_totais_orcadas, 0), 2) AS orcamento_total,
          TRUNCATE(COALESCE(hc.total_horas_lancadas, 0), 2) AS horas_consumidas,
          TRUNCATE(COALESCE(hc.horas_mes_passado, 0), 2) AS horas_mes_passado,
          TRUNCATE((COALESCE(oc.horas_totais_orcadas, 0) - COALESCE(hc.total_horas_lancadas, 0)), 2) AS horas_restantes
      FROM adminis.projetosaht proj
      LEFT JOIN OrcamentoContrato oc ON proj.id = oc.idContrato 
      LEFT JOIN HorasConsumidas hc ON proj.id = hc.idContrato
      WHERE RIGHT(proj.centroCusto, 6) = ?;
    `;
    
    const [rows] = await mysqlPool.execute(query, [account, account, account]);

    if (rows.length > 0) {
      res.json(rows[0]); 
    } else {
      res.json(null); 
    }
  } catch (err) {
    console.error("MySQL Error:", err);
    res.status(500).send("Error fetching client hours");
  }
});

app.get("/api/client-hours-details", requireAuth, async (req, res) => {
  const { account, year, month } = req.query;
  if (!account) return res.json(null);

  // Dynamically build the date filter string and parameters
  let dateFilter = "";
  const params = [account, account];

  if (year && year !== "all") {
    dateFilter += " AND YEAR(l.data) = ? ";
    params.push(year);
  }
  if (month && month !== "all") {
    dateFilter += " AND MONTH(l.data) = ? ";
    params.push(month);
  }
  
  // Add account again for the final WHERE clause at the end of the query
  params.push(account); 

  try {
    const query = `
      WITH OrcamentoDisciplina AS (
          SELECT 
              p.idContrato,
              p.idDisciplina,
              p.descricaoDisciplina,
              SUM(p.horaPadraoPlanejada) AS horas_orcadas
          FROM adminis.planejadoaht p
          WHERE p.idContrato IN (SELECT id FROM adminis.projetosaht WHERE RIGHT(centroCusto, 6) = ?)
          GROUP BY p.idContrato, p.idDisciplina, p.descricaoDisciplina
      ),
      HorasConsumidas AS (
          SELECT 
              l.idContrato,
              l.idDisciplina,
              SUM(
                  CASE 
                      WHEN DAY(CURRENT_DATE) >= 6 AND l.data < DATE_FORMAT(CURRENT_DATE, '%Y-%m-01') 
                      THEN l.horasPadrao 
                      WHEN DAY(CURRENT_DATE) < 6 AND l.data < DATE_FORMAT(CURRENT_DATE - INTERVAL 1 MONTH, '%Y-%m-01') 
                      THEN l.horasPadrao 
                      ELSE 0 
                  END
              ) AS horas_consumidas,
              SUM(
                  CASE 
                      WHEN DAY(CURRENT_DATE) >= 6 
                           AND YEAR(l.data) = YEAR(CURRENT_DATE - INTERVAL 1 MONTH) 
                           AND MONTH(l.data) = MONTH(CURRENT_DATE - INTERVAL 1 MONTH) 
                      THEN l.horasPadrao 
                      WHEN DAY(CURRENT_DATE) < 6
                           AND YEAR(l.data) = YEAR(CURRENT_DATE - INTERVAL 2 MONTH) 
                           AND MONTH(l.data) = MONTH(CURRENT_DATE - INTERVAL 2 MONTH) 
                      THEN l.horasPadrao 
                      ELSE 0 
                  END
              ) AS horas_mes_passado
          FROM adminis.lancamentosaht l
          WHERE l.idContrato IN (SELECT id FROM adminis.projetosaht WHERE RIGHT(centroCusto, 6) = ?)
          ${dateFilter}
          GROUP BY l.idContrato, l.idDisciplina
      )
      SELECT 
          proj.centroCusto AS Ct_Centro_Custo, 
          od.descricaoDisciplina AS Di_Descricao,
          TRUNCATE(COALESCE(od.horas_orcadas, 0), 2) AS orcamento_disciplina,
          TRUNCATE(COALESCE(hc.horas_consumidas, 0), 2) AS horas_consumidas_disciplina,
          TRUNCATE(COALESCE(hc.horas_mes_passado, 0), 2) AS horas_mes_passado_disciplina,
          TRUNCATE((COALESCE(od.horas_orcadas, 0) - COALESCE(hc.horas_consumidas, 0)), 2) AS horas_restantes_disciplina
      FROM adminis.projetosaht proj
      JOIN OrcamentoDisciplina od ON proj.id = od.idContrato 
      LEFT JOIN HorasConsumidas hc ON od.idContrato = hc.idContrato AND od.idDisciplina = hc.idDisciplina
      WHERE RIGHT(proj.centroCusto, 6) = ?;
    `;
    
    const [rows] = await mysqlPool.execute(query, params);
    res.json(rows);
    
  } catch (err) {
    console.error("MySQL Error on details:", err);
    res.status(500).send("Error fetching client hours details");
  }
});
//Overview

app.get("/api/yearly-overview", requireAuth, async (req, res) => {
  try {
    // 1. Get the login from the frontend
    let targetLogin = req.query.owner && req.query.owner.trim() !== "" ? req.query.owner : null;
    
    // 2. Override for gerentes using their SESSION LOGIN
    if (req.session.user?.role === "gerente") {
      targetLogin = req.session.user.login; 
    }
    
    console.log("Searching MySQL for login:", `"${targetLogin}"`);
    const account = req.query.account && req.query.account.trim() !== "" ? req.query.account : null;

    let allowedAccounts = null; 
    
    // 3. Fetch passing the login!
    if (targetLogin) {
      allowedAccounts = await getAllowedCostCenters(targetLogin);
      if (allowedAccounts.length === 0) {
        return res.json({ years: [], data: {} });
      }
    }

    if (account) {
      if (allowedAccounts && !allowedAccounts.includes(account)) {
        return res.json({ years: [], data: {} }); 
      }
      allowedAccounts = [account]; 
    }

    // UPDATED SQL: Now groups by and fetches the category_name
    // UPDATED SQL: Forces a join between all valid years and all categories
    let query = `
      WITH tx AS (
        SELECT
          EXTRACT(YEAR FROM t.mes) AS ano,
          t.codigo,
          RIGHT(t.ccusto, 6) AS ccusto, -- Group by the last 6 digits
          SUM(t.debito + t.credito) AS total
        FROM transacoes t
        WHERE 1=1
    `;
    
    let params = [];
    if (allowedAccounts) {
      // Clean the array to only contain the last 6 characters before asking Postgres
      const pgAccounts = allowedAccounts.map(acc => acc.length > 6 ? acc.slice(-6) : acc);
      
      query += ` AND RIGHT(t.ccusto, 6) = ANY($1::text[]) `;
      params.push(pgAccounts);
    }

    query += `
        GROUP BY ano, t.codigo, RIGHT(t.ccusto, 6) -- Group by the last 6 digits
      ),
      anos AS (
        SELECT DISTINCT ano FROM tx WHERE ano IS NOT NULL
      ),
      cat_anos AS (
        SELECT c.*, a.ano
        FROM categorias c
        LEFT JOIN anos a ON 1=1
      )
      SELECT
        ca.ano,
        ca.titulo,
        ca.topico,
        ca.nome_da_categoria AS category_name,
        ca.id,
        SUM(tx.total) AS total
      FROM cat_anos ca
      LEFT JOIN codigos co ON co.id_da_categoria = ca.id
      LEFT JOIN tx ON tx.codigo = co.codigo AND tx.ano = ca.ano
      GROUP BY ca.ano, ca.titulo, ca.topico, ca.nome_da_categoria, ca.id, ca.ordem_titulo, ca.ordem_topico
      ORDER BY ca.ordem_titulo, ca.ordem_topico, ca.titulo, ca.topico, ca.nome_da_categoria, ca.ano;
    `;

    const { rows } = await pool.query(query, params);

    const result = {};
    const yearsSet = new Set();

    // Map the new data format so it matches what our frontend expects
    for (const r of rows) {
      if (r.ano) yearsSet.add(r.ano);

      if (!result[r.topico]) {
        result[r.topico] = {
          titulo: r.titulo,
          totals: {},
          categoriesMap: {}
        };
      }

      if (r.ano) {
        result[r.topico].totals[r.ano] = (result[r.topico].totals[r.ano] || 0) + Number(r.total);
        
        if (!result[r.topico].categoriesMap[r.category_name]) {
          result[r.topico].categoriesMap[r.category_name] = { category_name: r.category_name };
        }
        result[r.topico].categoriesMap[r.category_name][r.ano] = Number(r.total);
      } else {
        // Ensure category exists even if there are 0 transactions
        if (!result[r.topico].categoriesMap[r.category_name]) {
          result[r.topico].categoriesMap[r.category_name] = { category_name: r.category_name };
        }
      }
    }

    // Convert map to array for the frontend
    for (const topico in result) {
      result[topico].categories = Object.values(result[topico].categoriesMap);
      delete result[topico].categoriesMap;
    }

    res.json({
      years: Array.from(yearsSet).sort(),
      data: result
    });
  } catch (err) {
    console.error("Error fetching yearly overview:", err);
    res.status(500).send("Error fetching yearly overview");
  }
});


//By year
app.get("/api/monthly-profit", requireAuth, async (req, res) => {
  try {
    let targetLogin = req.query.owner && req.query.owner.trim() !== "" ? req.query.owner : null;
    
    if (req.session.user?.role === "gerente") {
      targetLogin = req.session.user.login; // FIXED!
    }
    
    const account = req.query.account && req.query.account.trim() !== "" ? req.query.account : null;

    let allowedAccounts = null; 
    
    if (targetLogin) {
      allowedAccounts = await getAllowedCostCenters(targetLogin);
      if (allowedAccounts.length === 0) {
        return res.json({}); 
      }
    }

    if (account) {
      if (allowedAccounts && !allowedAccounts.includes(account)) {
        return res.json({}); 
      }
      allowedAccounts = [account]; 
    }

    // Step 2: Query PostgreSQL with the allowed array
  // Step 2: Query PostgreSQL with the allowed array and the cross-referenced CTE
    let query = `
      WITH tx AS (
        SELECT 
            t.codigo,
            RIGHT(t.ccusto, 6) AS ccusto, -- Group by the last 6 digits
            EXTRACT(YEAR  FROM t.mes)  AS ano,
            EXTRACT(MONTH FROM t.mes) AS mes,
            SUM(t.debito + t.credito) AS total
        FROM transacoes t
        WHERE 1=1
    `;

    let params = [];
    if (allowedAccounts) {
      // Clean the array to only contain the last 6 characters before asking Postgres
      const pgAccounts = allowedAccounts.map(acc => acc.length > 6 ? acc.slice(-6) : acc);
      
      query += ` AND RIGHT(t.ccusto, 6) = ANY($1::text[]) `;
      params.push(pgAccounts);
    }

    query += `
        GROUP BY t.codigo, RIGHT(t.ccusto, 6), ano, mes -- Group by the last 6 digits
      ),
      anos AS (
        SELECT DISTINCT ano FROM tx WHERE ano IS NOT NULL
      ),
      cat_anos AS (
        SELECT c.*, a.ano
        FROM categorias c
        LEFT JOIN anos a ON 1=1
      )
      SELECT 
          ca.ano,
          ca.titulo,
          ca.topico,
          ca.nome_da_categoria AS category_name,
          ca.id,
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
      FROM cat_anos ca
      LEFT JOIN codigos co ON co.id_da_categoria = ca.id
      LEFT JOIN tx ON tx.codigo = co.codigo AND tx.ano = ca.ano
      GROUP BY
          ca.ano,
          ca.titulo,
          ca.topico,
          ca.nome_da_categoria,
          ca.id,
          ca.ordem_titulo,
          ca.ordem_topico
      ORDER BY
          ca.ano,
          ca.ordem_titulo,
          ca.ordem_topico,
          ca.titulo,
          ca.topico;
    `;

    const { rows } = await pool.query(query, params);
    const result = {};

    for (const row of rows) {
      const year = row.ano;
      if (!result[year]) result[year] = {};
      
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

      for (const m in result[year][row.topico].totals) {
        result[year][row.topico].totals[m] += Number(row[m]);
      }
      result[year][row.topico].categories.push(row);
    }

    res.json(result);
  } catch (err) {
    console.error("Error fetching monthly profit:", err);
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
// ---------------------------------------------------------
// GET: Fetch specific transaction details for editing
// ---------------------------------------------------------
app.get("/api/transaction-details", requireAuth, async (req, res) => {
  const { year, month, ccusto, categoryId } = req.query;

  if (req.session.user.role !== "admin") {
    return res.status(403).json({ error: "Forbidden" });
  }

  try {
    const query = `
      SELECT t.id, t.codigo, t.descricao, t.debito, t.credito, t.mes, t.ccusto
      FROM transacoes t
      JOIN codigos co ON t.codigo = co.codigo
      WHERE EXTRACT(YEAR FROM t.mes) = $1
        AND EXTRACT(MONTH FROM t.mes) = $2
        AND RIGHT(t.ccusto, 6) = $3
        AND co.id_da_categoria = $4
      ORDER BY t.id ASC
    `;
    
    const { rows } = await pool.query(query, [year, month, ccusto, categoryId]);

    // 2. Logic to figure out the default 10-digit CC to show the admin
    let suggestedCcusto = ccusto; // Fallback to 6 digits just in case
    
    if (rows.length > 0 && rows[0].ccusto) {
      // If there are existing rows, grab the 10 digits from the first one
      suggestedCcusto = rows[0].ccusto;
    } else {
      // If this is a R$ 0 cell (no existing rows), fetch the baseline 10 digits from MySQL
      const [ccRes] = await mysqlPool.execute(
        "SELECT centroCusto FROM adminis.projetosaht WHERE RIGHT(centroCusto, 6) = ? AND centroCusto IS NOT NULL LIMIT 1",
        [ccusto]
      );
      if (ccRes.length > 0 && ccRes[0].centroCusto) {
        suggestedCcusto = ccRes[0].centroCusto;
      }
    }

    // 3. Return both the rows AND the suggested cost center
    res.json({ transactions: rows, suggestedCcusto: suggestedCcusto });
  } catch (err) {
    console.error("Error fetching transaction details:", err);
    res.status(500).send("Erro ao buscar detalhes da transação");
  }
});

// ---------------------------------------------------------
// PUT: Update the transaction values
// ---------------------------------------------------------
app.put("/api/update-transaction", requireAuth, requireRole("admin"), async (req, res) => {
  const { id, debito, credito } = req.body;

  if (!id) {
    return res.status(400).send("ID da transação não fornecido");
  }

  try {
    await pool.query(
      `UPDATE transacoes 
       SET debito = $1, credito = $2 
       WHERE id = $3`,
      [Number(debito) || 0, Number(credito) || 0, id]
    );

    res.json({ success: true });
  } catch (err) {
    console.error("Error updating transaction:", err);
    res.status(500).send("Erro ao atualizar transação");
  }
});


// ---------------------------------------------------------
// POST: Add a new transaction manually
// ---------------------------------------------------------
app.post("/api/add-transaction", requireAuth, requireRole("admin"), async (req, res) => {
  // Notice we are now receiving 'fullCcusto' directly from the frontend
  const { year, month, fullCcusto, categoryId, categoryName, debito, credito } = req.body;

  try {
    const codeRes = await pool.query(
      "SELECT codigo FROM codigos WHERE id_da_categoria = $1 LIMIT 1",
      [categoryId]
    );

    if (codeRes.rows.length === 0) {
      return res.status(400).send("Categoria sem código associado.");
    }

    const defaultCodigo = codeRes.rows[0].codigo;

    // Fetch the correct 'descricao' 
    const descRes = await pool.query(
      "SELECT descricao FROM transacoes WHERE codigo = $1 AND descricao IS NOT NULL LIMIT 1",
      [defaultCodigo]
    );
    const descricao = descRes.rows.length > 0 ? descRes.rows[0].descricao : categoryName;
    
    const mesDate = `${year}-${String(month).padStart(2, '0')}-01`;

    // Insert using the explicitly provided fullCcusto
    await pool.query(
      `INSERT INTO transacoes (codigo, descricao, ccusto, debito, credito, mes)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [defaultCodigo, descricao, fullCcusto, Number(debito) || 0, Number(credito) || 0, mesDate]
    );

    res.json({ success: true });
  } catch (err) {
    console.error("Erro ao adicionar transação:", err);
    res.status(500).send("Erro interno ao adicionar transação");
  }
});


// ---------------------------------------------------------
// DELETE: Remove a transaction
// ---------------------------------------------------------
app.delete("/api/delete-transaction", requireAuth, requireRole("admin"), async (req, res) => {
  const { id } = req.body;

  if (!id) {
    return res.status(400).send("ID da transação não fornecido");
  }

  try {
    // Safely delete only the specific row matching the ID
    await pool.query("DELETE FROM transacoes WHERE id = $1", [id]);
    res.json({ success: true });
  } catch (err) {
    console.error("Error deleting transaction:", err);
    res.status(500).send("Erro ao deletar transação");
  }
});


app.get("/api/client-hours-periods", requireAuth, async (req, res) => {
  const account = req.query.account;
  if (!account) return res.json([]);

  try {
    const query = `
      SELECT DISTINCT 
          YEAR(l.data) AS ano, 
          MONTH(l.data) AS mes
      FROM adminis.lancamentosaht l
      WHERE l.idContrato IN (SELECT id FROM adminis.projetosaht WHERE RIGHT(centroCusto, 6) = ?)
      ORDER BY ano DESC, mes DESC;
    `;
    const [rows] = await mysqlPool.execute(query, [account]);
    res.json(rows);
  } catch (err) {
    console.error("Error fetching periods:", err);
    res.status(500).send("Error fetching client hours periods");
  }
});

app.get("/api/owners", requireAuth, async (req, res) => {
  try {
    if (req.session.user.role === "gerente") {
      return res.json([
        { nome: req.session.user.nome, login: req.session.user.login } 
      ]);
    }

    const query = `
      SELECT DISTINCT u.nome AS nome, u.login AS login 
      FROM adminis.projetosaht p
      JOIN adminis.usuarioaht u ON p.idGerente = u.id
      WHERE p.dataInicio >= '${MIN_DATE_FILTER}'
        AND p.centroCusto IS NOT NULL
      ORDER BY u.nome;
    `;

    const [rows] = await mysqlPool.execute(query);
    res.json(rows);

  } catch (err) {
    console.error("Error fetching owners:", err);
    res.status(500).send("Error fetching owners");
  }
});

//serve regardless of index.html
app.get("/", (req, res) => {
  if (!req.session.user)
    return res.redirect("/login.html");
  
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// Start server and listen for requests
const PORT = 3000;

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on port ${PORT}`);
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