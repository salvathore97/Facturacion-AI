import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import Redis from 'ioredis';
import { registerBackupRunner } from './backupRunner.js';

dotenv.config({ path: '.env.local' });
dotenv.config();

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));

const PORT = Number(process.env.AI_PORT || 3005);
const OLLAMA_URL = (process.env.OLLAMA_URL || 'http://10.0.0.91:11434').replace(/\/$/, '');
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'qwen2.5:3b';
const INSFORGE_URL = (process.env.VITE_INSFORGE_URL || process.env.VITE_SUPABASE_URL || 'https://bdai.salvathore.lat').replace(/\/$/, '');
const INSFORGE_KEY = process.env.INSFORGE_ADMIN_KEY || process.env.VITE_INSFORGE_ANON_KEY || '';
const SCHEMA = process.env.VITE_INSFORGE_SCHEMA || 'salvathorefactos';

// ── Cache (Redis opcional con fallback automático en memoria TTL 120s) ──
const memCache = new Map();
let redisClient = null;
if (process.env.REDIS_URL) {
  try {
    const client = new Redis(process.env.REDIS_URL, {
      maxRetriesPerRequest: 1,
      lazyConnect: true,
      retryStrategy: () => null,
    });
    client.on('error', () => {
      redisClient = null;
    });
    client.connect().then(() => {
      redisClient = client;
    }).catch(() => {
      redisClient = null;
      client.disconnect();
    });
  } catch {
    redisClient = null;
  }
}

async function cacheGet(key) {
  if (redisClient?.status === 'ready') {
    const val = await redisClient.get(key);
    return val ? JSON.parse(val) : null;
  }
  const hit = memCache.get(key);
  if (!hit) return null;
  if (Date.now() > hit.exp) {
    memCache.delete(key);
    return null;
  }
  return hit.val;
}

async function cacheSet(key, val, ttlSec = 120) {
  if (redisClient?.status === 'ready') {
    await redisClient.setex(key, ttlSec, JSON.stringify(val));
    return;
  }
  memCache.set(key, { val, exp: Date.now() + ttlSec * 1000 });
}

// ── Helper PostgREST (Solo Lectura GET) ──
async function dbGet(table, queryStr, userAuthHeader = '', { requireUserJwt = false } = {}) {
  const url = `${INSFORGE_URL}/api/database/records/${table}?${queryStr}`;
  const hasUserJwt = userAuthHeader && userAuthHeader.startsWith('Bearer ');
  if (requireUserJwt && !hasUserJwt) {
    throw new Error('Se requiere autenticación (Bearer token).');
  }
  const bearer = hasUserJwt ? userAuthHeader : `Bearer ${INSFORGE_KEY}`;
  const res = await fetch(url, {
    headers: {
      apikey: hasUserJwt ? (process.env.VITE_INSFORGE_ANON_KEY || INSFORGE_KEY) : INSFORGE_KEY,
      Authorization: bearer,
      'Accept-Profile': SCHEMA,
    },
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`PostgREST ${table} ${res.status}: ${txt.slice(0, 160)}`);
  }
  return res.json();
}

async function verifyJwtProfile(authHeader) {
  if (!authHeader || !authHeader.startsWith('Bearer ')) return null;
  try {
    const token = authHeader.slice(7).trim();
    const parts = token.split('.');
    let subFilter = '';
    if (parts.length >= 2) {
      const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
      if (payload?.sub) {
        subFilter = `&id=eq.${encodeURIComponent(payload.sub)}`;
      }
    }
    const rows = await dbGet('profiles', `select=id,idempresa,is_superadmin${subFilter}&limit=1`, authHeader, { requireUserJwt: true });
    return Array.isArray(rows) && rows.length > 0 ? rows[0] : null;
  } catch {
    return null;
  }
}

async function requireSuperAdminOrSecret(req, res, next) {
  const secret = req.headers['x-backup-secret'] || '';
  if (INSFORGE_KEY && secret === INSFORGE_KEY) return next();

  const profile = await verifyJwtProfile(req.headers.authorization || '');
  if (!profile || !profile.is_superadmin) {
    return res.status(401).json({ ok: false, error: 'Acceso restringido a Super Admin o clave interna.' });
  }
  req.authProfile = profile;
  return next();
}

// ── Helper Ollama ──
async function ollamaGenerate(prompt, { system = '', format = undefined, model = OLLAMA_MODEL } = {}) {
  const res = await fetch(`${OLLAMA_URL}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      system,
      prompt,
      stream: false,
      ...(format ? { format } : {}),
      options: {
        num_ctx: 4096,
        num_thread: 8,
        temperature: 0.1,
      },
    }),
  });
  if (!res.ok) {
    throw new Error(`Ollama error HTTP ${res.status}`);
  }
  const data = await res.json();
  return data.response || '';
}

function normalizeDateBounds(dateFrom, dateTo) {
  const today = new Date().toISOString().slice(0, 10);
  const from = dateFrom && /^\d{4}-\d{2}-\d{2}$/.test(dateFrom) ? dateFrom : today;
  const to = dateTo && /^\d{4}-\d{2}-\d{2}$/.test(dateTo) ? dateTo : from;
  return { from, to };
}

function hasModule(allowedModules, mod) {
  if (!Array.isArray(allowedModules) || allowedModules.length === 0) return true;
  return allowedModules.includes('*') || allowedModules.includes(mod);
}

function cleanSearch(val, companyName = '') {
  if (val === null || val === undefined) return null;
  const s = String(val).trim();
  if (!s) return null;
  const lower = s.toLowerCase();
  if (['null', 'none', 'undefined', 'n/a', 'todos', 'todas', 'all', 'ninguno', 'pendientes', 'cobro', 'stock', 'inventario'].includes(lower)) {
    return null;
  }
  if (companyName && lower === companyName.toLowerCase()) return null;
  return s;
}

async function loadActiveSkills(idempresa, authHeader = '') {
  const cacheKey = `ai:skills:${idempresa}`;
  const cached = await cacheGet(cacheKey);
  if (cached) return cached;
  try {
    const all = await dbGet('ia_skills', `select=titulo,instruccion,ejemplo_pregunta,intent,idempresa&activo=eq.true`, authHeader);
    const filtered = (all || []).filter((s) => s.idempresa === null || String(s.idempresa) === String(idempresa));
    await cacheSet(cacheKey, filtered, 60);
    return filtered;
  } catch {
    return [];
  }
}

// ── Planificador de Consultas (Reglas Rápidas + Few-Shot Ollama + Skills) ──
async function extractQueryPlan(question, companyName = '', skills = []) {
  const today = new Date().toISOString().slice(0, 10);
  const qLower = question.toLowerCase().trim();

  // Atajos deterministas (0ms, 100% precisos para consultas frecuentes)
  if (/pendiente.*cobro|cuentas por cobrar|por cobrar|deben|adeudan/.test(qLower) && !/cliente\s+\w+/.test(qLower)) {
    return { intent: 'unpaid_invoices', search: null, limit: 20 };
  }
  if (/stock bajo|bajo stock|poco stock|agotad/.test(qLower)) {
    return { intent: 'stock_status', low_only: true, search: null, limit: 20 };
  }
  if (/resumen de ventas de este mes|ventas del mes|facturacion del mes|facturación del mes/.test(qLower)) {
    const firstOfMonth = `${today.slice(0, 7)}-01`;
    return { intent: 'sales_summary', date_from: firstOfMonth, date_to: today, limit: 20 };
  }
  if (/m[aá]s.*vendi[oó].*hoy|vendi[oó].*m[aá]s.*hoy/.test(qLower)) {
    return { intent: 'top_products_sold', date_from: today, date_to: today, limit: 10 };
  }

  const system = `Eres un planificador de consultas de solo lectura para un ERP multi-empresa en República Dominicana.
Fecha actual: ${today}.
Convierte la pregunta del usuario en UN objeto JSON estricto con esta estructura:
{
  "intent": "top_products_sold" | "sales_summary" | "unpaid_invoices" | "stock_status" | "clients_summary" | "expenses_summary" | "bookings_summary" | "general_help",
  "date_from": null,
  "date_to": null,
  "search": null,
  "low_only": false,
  "limit": 10
}
Ejemplos entrenados:
- "Facturas pendientes de cobro" -> {"intent":"unpaid_invoices","date_from":null,"date_to":null,"search":null,"low_only":false,"limit":20}
- "Qué producto se vendió más el martes 13 de agosto" -> {"intent":"top_products_sold","date_from":"${today.slice(0, 4)}-08-13","date_to":"${today.slice(0, 4)}-08-13","search":null,"low_only":false,"limit":10}
- "Cuánto se vendió ayer" -> {"intent":"sales_summary","date_from":"AYER","date_to":"AYER","search":null,"low_only":false,"limit":10}
- "Stock de pintura" -> {"intent":"stock_status","date_from":null,"date_to":null,"search":"pintura","low_only":false,"limit":15}
Reglas:
- Si no piden filtrar por un nombre específico de cliente o producto, DEBES poner "search": null (nunca pongas la palabra "null" entre comillas ni el nombre de la empresa).
${skills.length > 0 ? `\nSkills entrenadas:\n${skills.map((s) => `- [${s.intent}] ${s.titulo}: ${s.instruccion}${s.ejemplo_pregunta ? ` (Ej: "${s.ejemplo_pregunta}")` : ''}`).join('\n')}` : ''}
Responde ÚNICAMENTE con JSON válido.`;

  const raw = await ollamaGenerate(question, { system, format: 'json' });
  try {
    const parsed = JSON.parse(raw);
    parsed.search = cleanSearch(parsed.search, companyName);
    return parsed;
  } catch {
    return { intent: 'general_help', search: null, limit: 10 };
  }
}

// ── Ejecución Segura Aislada por idempresa ──
async function executePlan(plan, { idempresa, allowedModules, authHeader = '' }) {
  const limit = Math.min(20, Math.max(5, Number(plan.limit) || 10));

  switch (plan.intent) {
    case 'top_products_sold': {
      if (!hasModule(allowedModules, 'ventas') && !hasModule(allowedModules, 'tpv')) {
        return { denied: true, reason: 'No tienes permiso para consultar ventas.' };
      }
      const { from, to } = normalizeDateBounds(plan.date_from, plan.date_to);
      const invoices = await dbGet(
        'facturascli',
        `select=idfactura,codigo,fecha,total&idempresa=eq.${idempresa}&fecha=gte.${from}&fecha=lte.${to}&limit=200`,
        authHeader
      );
      if (!invoices.length) {
        return { rows: [], columns: [], meta: { from, to, invoicesCount: 0 } };
      }
      const ids = invoices.map((i) => i.idfactura).join(',');
      const lines = await dbGet(
        'lineasfacturascli',
        `select=referencia,descripcion,cantidad,pvptotal&idfactura=in.(${ids})&limit=1000`,
        authHeader
      );
      const agg = new Map();
      for (const l of lines) {
        const key = l.referencia || l.descripcion || 'SIN_REF';
        const cur = agg.get(key) || {
          referencia: l.referencia || '—',
          descripcion: l.descripcion || 'Artículo',
          cantidad: 0,
          total: 0,
        };
        cur.cantidad += Number(l.cantidad || 0);
        cur.total += Number(l.pvptotal || 0);
        agg.set(key, cur);
      }
      const rows = Array.from(agg.values())
        .sort((a, b) => b.cantidad - a.cantidad)
        .slice(0, limit);
      return {
        rows,
        columns: ['referencia', 'descripcion', 'cantidad', 'total'],
        meta: { from, to, invoicesCount: invoices.length },
      };
    }

    case 'sales_summary': {
      if (!hasModule(allowedModules, 'ventas') && !hasModule(allowedModules, 'tpv')) {
        return { denied: true, reason: 'No tienes permiso para consultar ventas.' };
      }
      const { from, to } = normalizeDateBounds(plan.date_from, plan.date_to);
      const invoices = await dbGet(
        'facturascli',
        `select=idfactura,codigo,nombrecliente,fecha,total,totaliva,pagada&idempresa=eq.${idempresa}&fecha=gte.${from}&fecha=lte.${to}&order=idfactura.desc&limit=200`,
        authHeader
      );
      const total = invoices.reduce((s, f) => s + Number(f.total || 0), 0);
      const cobrado = invoices.filter((f) => f.pagada).reduce((s, f) => s + Number(f.total || 0), 0);
      const pendiente = total - cobrado;
      const itbis = invoices.reduce((s, f) => s + Number(f.totaliva || 0), 0);
      return {
        rows: invoices.slice(0, limit),
        columns: ['codigo', 'nombrecliente', 'fecha', 'total', 'pagada'],
        meta: { from, to, count: invoices.length, total, cobrado, pendiente, itbis },
      };
    }

    case 'unpaid_invoices': {
      if (!hasModule(allowedModules, 'ventas')) {
        return { denied: true, reason: 'No tienes permiso para consultar cuentas por cobrar.' };
      }
      let q = `select=codigo,nombrecliente,fecha,total&idempresa=eq.${idempresa}&pagada=not.is.true&order=idfactura.desc&limit=${limit}`;
      if (plan.search) q += `&nombrecliente=ilike.*${encodeURIComponent(plan.search)}*`;
      const rows = await dbGet('facturascli', q, authHeader);
      const totalPendiente = rows.reduce((s, r) => s + Number(r.total || 0), 0);
      return { rows, columns: ['codigo', 'nombrecliente', 'fecha', 'total'], meta: { count: rows.length, totalPendiente } };
    }

    case 'stock_status': {
      if (!hasModule(allowedModules, 'almacen') && !hasModule(allowedModules, 'ventas')) {
        return { denied: true, reason: 'No tienes permiso para consultar inventario.' };
      }
      let q = `select=referencia,descripcion,precio,stockfis&idempresa=eq.${idempresa}&order=stockfis.asc&limit=${limit}`;
      if (plan.search) q += `&descripcion=ilike.*${encodeURIComponent(plan.search)}*`;
      let rows = await dbGet('productos', q, authHeader);
      if (plan.low_only) {
        rows = rows.filter((r) => Number(r.stockfis || 0) <= 5);
      }
      return { rows, columns: ['referencia', 'descripcion', 'stockfis', 'precio'], meta: { count: rows.length } };
    }

    case 'clients_summary': {
      if (!hasModule(allowedModules, 'ventas')) {
        return { denied: true, reason: 'No tienes permiso para consultar clientes.' };
      }
      let q = `select=codcliente,nombre,cifnif,telefono1,email&idempresa=eq.${idempresa}&order=nombre.asc&limit=${limit}`;
      if (plan.search) q += `&nombre=ilike.*${encodeURIComponent(plan.search)}*`;
      const rows = await dbGet('clientes', q, authHeader);
      return { rows, columns: ['nombre', 'cifnif', 'telefono1', 'email'], meta: { count: rows.length } };
    }

    case 'expenses_summary': {
      if (!hasModule(allowedModules, 'contabilidad')) {
        return { denied: true, reason: 'No tienes permiso para consultar gastos.' };
      }
      const { from, to } = normalizeDateBounds(plan.date_from, plan.date_to);
      const rows = await dbGet(
        'gastos',
        `select=concepto,proveedor,fecha,total&idempresa=eq.${idempresa}&fecha=gte.${from}&fecha=lte.${to}&order=idgasto.desc&limit=${limit}`,
        authHeader
      );
      const totalGastos = rows.reduce((s, r) => s + Number(r.total || 0), 0);
      return { rows, columns: ['concepto', 'proveedor', 'fecha', 'total'], meta: { from, to, totalGastos } };
    }

    case 'bookings_summary': {
      const { from, to } = normalizeDateBounds(plan.date_from, plan.date_to);
      const rows = await dbGet(
        'reservas',
        `select=cliente_nombre,servicio,fecha,hora,estado&idempresa=eq.${idempresa}&fecha=gte.${from}&fecha=lte.${to}&order=fecha.asc&limit=${limit}`,
        authHeader
      );
      return { rows, columns: ['cliente_nombre', 'servicio', 'fecha', 'hora', 'estado'], meta: { from, to } };
    }

    default: {
      const faqs = await dbGet('faq_documentacion', 'select=titulo,contenido,modulo&activo=eq.true&limit=12', authHeader);
      return { rows: faqs, columns: ['titulo', 'modulo'], meta: { faqMode: true } };
    }
  }
}

app.get('/api/ai/health', async (_req, res) => {
  try {
    const r = await fetch(`${OLLAMA_URL}/api/tags`);
    const tags = r.ok ? await r.json() : { models: [] };
    res.json({
      ok: true,
      ollama: OLLAMA_URL,
      model: OLLAMA_MODEL,
      redis: redisClient?.status === 'ready' ? 'connected' : 'memory-fallback',
      modelsCount: (tags.models || []).length,
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/ai/query', async (req, res) => {
  const started = Date.now();
  try {
    const { question, idempresa, allowedModules = [], companyName = 'Tu Empresa', bypassEnabledCheck = false } = req.body || {};
    if (!question || !idempresa) {
      return res.status(400).json({ ok: false, error: 'Se requiere question e idempresa' });
    }

    const authHeader = req.headers.authorization || '';
    const userProfile = await verifyJwtProfile(authHeader);
    if (!userProfile) {
      return res.status(401).json({ ok: false, error: 'Sesión inválida o expirada. Inicia sesión nuevamente.' });
    }

    const targetEmpresaId = Number(idempresa);
    if (!userProfile.is_superadmin && Number(userProfile.idempresa) !== targetEmpresaId) {
      // Verificar si tiene permiso explícito multi-empresa en empresa_usuario_permisos
      const perms = await dbGet(
        'empresa_usuario_permisos',
        `select=id&idempresa=eq.${targetEmpresaId}&limit=1`,
        authHeader,
        { requireUserJwt: true }
      ).catch(() => []);
      if (!Array.isArray(perms) || perms.length === 0) {
        return res.status(403).json({ ok: false, error: 'No tienes acceso a esta empresa.' });
      }
    }

    const effectiveBypass = Boolean(bypassEnabledCheck && userProfile.is_superadmin);
    if (!effectiveBypass) {
      try {
        const empRows = await dbGet('empresas', `select=ia_habilitada&idempresa=eq.${targetEmpresaId}&limit=1`, authHeader, { requireUserJwt: true });
        if (empRows?.[0] && !empRows[0].ia_habilitada) {
          return res.status(403).json({ ok: false, error: 'El módulo de IA no está habilitado para esta empresa.' });
        }
      } catch {}
    }

    const cacheKey = `ai:q:${idempresa}:${question.trim().toLowerCase()}`;
    const cached = await cacheGet(cacheKey);
    if (cached) {
      return res.json({ ...cached, cached: true, latencyMs: Date.now() - started });
    }

    const skills = await loadActiveSkills(idempresa, authHeader);
    const plan = await extractQueryPlan(question, companyName, skills);
    const result = await executePlan(plan, { idempresa, allowedModules, authHeader });

    if (result.denied) {
      return res.json({
        ok: true,
        answer: result.reason,
        rows: [],
        columns: [],
        intent: plan.intent,
        cached: false,
        latencyMs: Date.now() - started,
      });
    }

    const skillsContext = skills.length > 0
      ? `\nReglas y Skills del negocio:\n${skills.map((s) => `- ${s.titulo}: ${s.instruccion}`).join('\n')}`
      : '';

    const synthesisPrompt = `Empresa: ${companyName}
Pregunta del usuario: "${question}"
Intención detectada: ${plan.intent}
Metadatos: ${JSON.stringify(result.meta || {})}${skillsContext}
Datos reales de la base de datos (${result.rows.length} registros):
${JSON.stringify(result.rows.slice(0, 12))}

Redacta una respuesta ejecutiva, breve y clara en español usando ÚNICAMENTE estos datos reales. Si no hay registros, indícalo claramente. Formatea montos en RD$.`;

    const answer = await ollamaGenerate(synthesisPrompt, {
      system: 'Eres el asistente analítico de solo lectura de Salvathore Fact OS. Nunca inventes cifras.',
    });

    const payload = {
      ok: true,
      answer: answer.trim(),
      rows: result.rows,
      columns: result.columns,
      intent: plan.intent,
      meta: result.meta,
      model: OLLAMA_MODEL,
      cached: false,
    };

    await cacheSet(cacheKey, payload, 120);
    return res.json({ ...payload, latencyMs: Date.now() - started });
  } catch (err) {
    console.error('AI Query error:', err);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

async function insforgeFetch(pathWithQuery, opts = {}) {
  const method = (opts.method || 'GET').toUpperCase();
  const res = await fetch(`${INSFORGE_URL}/api/database/records/${pathWithQuery}`, {
    ...opts,
    headers: {
      apikey: INSFORGE_KEY,
      Authorization: `Bearer ${INSFORGE_KEY}`,
      'Accept-Profile': SCHEMA,
      ...(method !== 'GET' ? { 'Content-Profile': SCHEMA, 'Content-Type': 'application/json' } : {}),
      ...(opts.headers || {}),
    },
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`PostgREST ${method} ${pathWithQuery} -> ${res.status}: ${txt.slice(0, 160)}`);
  }
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

registerBackupRunner(app, insforgeFetch, requireSuperAdminOrSecret);

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Salvathore AI Bridge corriendo en http://0.0.0.0:${PORT} -> Ollama ${OLLAMA_URL} (${OLLAMA_MODEL})`);
});
