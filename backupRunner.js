import crypto from 'node:crypto';

const BACKUP_TABLES = [
  'clientes',
  'contactos',
  'almacenes',
  'cuentas',
  'subcuentas',
  'config_contable',
  'asientos',
  'caja_turnos',
  'academia_cursos',
  'academia_estudiantes',
  'academia_inscripciones',
  'academia_certificados',
  'academia_templates_certificados',
  'formaspago',
  'series',
  'ejercicios',
  'productos',
  'familias',
  'fabricantes',
  'impuestos',
  'cuentasbancarias',
  'proveedores',
  'ncf_secuencias',
  'empresa_web_config',
  'empresa_usuario_permisos'
];

function getTenantColumn(table) {
  return (table === 'empresa_web_config' || table === 'ncf_secuencias') ? 'id_empresa' : 'idempresa';
}

function getGoogleServerConfig() {
  const rawSa = (process.env.GOOGLE_SERVICE_ACCOUNT_JSON || process.env.VITE_GOOGLE_SERVICE_ACCOUNT_JSON || '').trim();
  const folderId = (process.env.GOOGLE_DRIVE_FOLDER_ID || process.env.VITE_GOOGLE_DRIVE_FOLDER_ID || '').trim();
  const folderName = (process.env.GOOGLE_DRIVE_FOLDER_NAME || process.env.VITE_GOOGLE_DRIVE_FOLDER_NAME || 'Salvathore_SaaS_Backups').trim();
  const clientId = (process.env.GOOGLE_CLIENT_ID || process.env.VITE_GOOGLE_CLIENT_ID || '').trim();
  const clientSecret = (process.env.GOOGLE_CLIENT_SECRET || '').trim();
  const refreshToken = (process.env.GOOGLE_REFRESH_TOKEN || '').trim();

  let serviceAccount = null;
  if (rawSa) {
    try {
      const jsonStr = rawSa.startsWith('{') ? rawSa : Buffer.from(rawSa, 'base64').toString('utf8');
      const parsed = JSON.parse(jsonStr);
      if (parsed.client_email && parsed.private_key) serviceAccount = parsed;
    } catch (e) {
      console.warn('[BackupCron] GOOGLE_SERVICE_ACCOUNT_JSON inválido:', e.message);
    }
  }

  return {
    serviceAccount,
    hasServiceAccount: Boolean(serviceAccount),
    hasRefreshToken: Boolean(clientId && clientSecret && refreshToken),
    clientId,
    clientSecret,
    refreshToken,
    folderId,
    folderName
  };
}

async function getServerDriveAccessToken(cfg) {
  if (cfg.hasServiceAccount) {
    const sa = cfg.serviceAccount;
    const now = Math.floor(Date.now() / 1000);
    const b64url = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
    const unsigned = `${b64url({ alg: 'RS256', typ: 'JWT' })}.${b64url({
      iss: sa.client_email,
      scope: 'https://www.googleapis.com/auth/drive',
      aud: sa.token_uri || 'https://oauth2.googleapis.com/token',
      exp: now + 3600,
      iat: now
    })}`;
    const privateKey = sa.private_key.replace(/\\n/g, '\n');
    const signer = crypto.createSign('RSA-SHA256');
    signer.update(unsigned);
    const sig = signer.sign(privateKey, 'base64url');

    const res = await fetch(sa.token_uri || 'https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion: `${unsigned}.${sig}`
      })
    });
    const data = await res.json();
    if (!res.ok || !data.access_token) {
      throw new Error(data.error_description || data.error || 'Error obteniendo token de Service Account');
    }
    return data.access_token;
  }

  if (cfg.hasRefreshToken) {
    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: cfg.clientId,
        client_secret: cfg.clientSecret,
        refresh_token: cfg.refreshToken,
        grant_type: 'refresh_token'
      })
    });
    const data = await res.json();
    if (!res.ok || !data.access_token) {
      throw new Error(data.error_description || data.error || 'Error renovando refresh_token de Google');
    }
    return data.access_token;
  }

  return null;
}

async function ensureDriveFolder(accessToken, name, parentId = null) {
  const safeName = name.replace(/'/g, "\\'");
  let q = `mimeType='application/vnd.google-apps.folder' and name='${safeName}' and trashed=false`;
  if (parentId) q += ` and '${parentId}' in parents`;

  const searchRes = await fetch(
    `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id,name)&pageSize=1`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  const searchData = await searchRes.json();
  if (searchRes.ok && searchData.files?.length > 0) return searchData.files[0].id;

  const meta = { name, mimeType: 'application/vnd.google-apps.folder' };
  if (parentId) meta.parents = [parentId];

  const createRes = await fetch('https://www.googleapis.com/drive/v3/files?fields=id', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(meta)
  });
  const created = await createRes.json();
  if (!createRes.ok || !created.id) {
    throw new Error(created?.error?.message || 'No se pudo crear carpeta en Google Drive');
  }
  return created.id;
}

async function uploadJsonToDrive(accessToken, fileName, jsonString, folderName, rootFolderId, subfolderName) {
  const rootId = rootFolderId || (await ensureDriveFolder(accessToken, folderName || 'Salvathore_SaaS_Backups'));
  const targetFolderId = subfolderName ? await ensureDriveFolder(accessToken, subfolderName, rootId) : rootId;

  const boundary = 'salvathore_cron_boundary_' + Date.now();
  const metadata = { name: fileName, parents: [targetFolderId], mimeType: 'application/json' };
  const body =
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n` +
    `--${boundary}\r\nContent-Type: application/json\r\n\r\n${jsonString}\r\n` +
    `--${boundary}--`;

  const res = await fetch(
    'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,webViewLink',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': `multipart/related; boundary=${boundary}`
      },
      body
    }
  );
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error?.message || `Drive upload HTTP ${res.status}`);
  return data;
}

export function registerBackupRunner(app, insforgeFetch) {
  const state = {
    running: false,
    lastRunAt: null,
    lastRunDateRd: null,
    lastSummary: null,
    scheduledTestAt: null,
    cronHourRd: Number(process.env.BACKUP_CRON_HOUR ?? 2) // 02:00 AM Santo Domingo
  };
  let testTimer = null;

  async function resolveGoogleServerConfig() {
    const cfg = getGoogleServerConfig();
    if (!cfg.refreshToken) {
      try {
        const rows = await insforgeFetch('admin_integraciones?servicio=eq.google_drive_server&select=activo,config&limit=1');
        const row = Array.isArray(rows) ? rows[0] : null;
        if (row?.activo && row?.config?.refresh_token) {
          cfg.refreshToken = row.config.refresh_token;
          cfg.hasRefreshToken = Boolean(cfg.clientId && cfg.clientSecret && cfg.refreshToken);
        }
      } catch {
        // ignorar si aún no existe registro
      }
    }
    return cfg;
  }

  async function runBackups({ idempresa = null, trigger = 'cron' } = {}) {
    if (state.running) return { ok: false, error: 'Ya hay un respaldo en ejecución' };
    state.running = true;

    try {
      const empFilter = idempresa ? `&idempresa=eq.${Number(idempresa)}` : '';
      const empresas = await insforgeFetch(`empresas?select=idempresa,nombre,nombrecorto${empFilter}&order=idempresa.asc`);
      if (!Array.isArray(empresas) || empresas.length === 0) {
        return { ok: true, processed: 0, results: [] };
      }

      const gCfg = await resolveGoogleServerConfig();
      let driveToken = null;
      let driveAuthError = null;
      if (gCfg.hasServiceAccount || gCfg.hasRefreshToken) {
        try {
          driveToken = await getServerDriveAccessToken(gCfg);
        } catch (err) {
          driveAuthError = err.message;
          console.warn('[BackupCron] Error autenticando Google Drive:', err.message);
        }
      }

      const results = [];
      for (const emp of empresas) {
        const empId = emp.idempresa;
        const empNombre = emp.nombrecorto || emp.nombre || `Empresa ${empId}`;
        const timestamp = new Date().toISOString();
        const dateStr = timestamp.replace(/[-:T]/g, '').slice(0, 14);
        const safeName = empNombre.toLowerCase().replace(/[^a-z0-9_-]/g, '_');
        const nombreArchivo = `backup_emp_${empId}_${safeName}_${dateStr}.json`;

        const tablesData = {};
        const tableCounts = {};
        let totalRecords = 0;

        for (const table of BACKUP_TABLES) {
          const col = getTenantColumn(table);
          try {
            const rows = await insforgeFetch(`${table}?${col}=eq.${empId}`);
            if (Array.isArray(rows)) {
              tablesData[table] = rows;
              tableCounts[table] = rows.length;
              totalRecords += rows.length;
            } else {
              tablesData[table] = [];
              tableCounts[table] = 0;
            }
          } catch {
            tablesData[table] = [];
            tableCounts[table] = 0;
          }
        }

        const backupPayload = {
          schema_version: '1.0',
          generated_at: timestamp,
          created_by: `Cron Servidor (${trigger})`,
          empresa: { idempresa: empId, nombre: empNombre },
          resumen: { total_registros: totalRecords, tablas: tableCounts },
          datos: tablesData
        };

        const jsonString = JSON.stringify(backupPayload, null, 2);
        const tamanoBytes = Buffer.byteLength(jsonString, 'utf8');

        let finalDestino = 'local';
        let urlCloud = null;
        let cloudError = driveAuthError;

        if (driveToken) {
          try {
            const uploaded = await uploadJsonToDrive(
              driveToken,
              nombreArchivo,
              jsonString,
              gCfg.folderName,
              gCfg.folderId,
              `Empresa_${empId}_${safeName}`
            );
            finalDestino = 'google_drive';
            urlCloud = uploaded.webViewLink || null;
          } catch (uErr) {
            cloudError = uErr.message;
          }
        }

        await insforgeFetch('empresa_backups', {
          method: 'POST',
          headers: { Prefer: 'return=minimal' },
          body: JSON.stringify([{
            idempresa: empId,
            nombre_archivo: nombreArchivo,
            tipo: 'automatico',
            destino: finalDestino,
            tamano_bytes: tamanoBytes,
            total_registros: totalRecords,
            estado: 'completado',
            resumen_tablas: tableCounts,
            datos_backup: backupPayload,
            url_cloud: urlCloud,
            created_by: `Cron Servidor (${trigger})`
          }])
        });

        results.push({
          idempresa: empId,
          nombre: empNombre,
          archivo: nombreArchivo,
          totalRecords,
          destino: finalDestino,
          urlCloud,
          cloudError
        });
      }

      state.lastRunAt = new Date().toISOString();
      state.lastSummary = { processed: results.length, results };
      return { ok: true, processed: results.length, results };
    } finally {
      state.running = false;
    }
  }

  // Verificar cada minuto si ya es la hora programada en Santo Domingo (UTC-4)
  setInterval(() => {
    const rdNow = new Date(Date.now() - 4 * 3600 * 1000);
    const todayRd = rdNow.toISOString().slice(0, 10);
    const hourRd = rdNow.getUTCHours();

    if (hourRd === state.cronHourRd && state.lastRunDateRd !== todayRd && !state.running) {
      state.lastRunDateRd = todayRd;
      console.log(`[BackupCron] Ejecutando respaldo automático diario (${todayRd} ${hourRd}:00 AST)...`);
      runBackups({ trigger: 'daily_02am' })
        .then((r) => console.log(`[BackupCron] Finalizado: ${r.processed || 0} empresa(s)`))
        .catch((e) => console.error('[BackupCron] Error:', e.message));
    }
  }, 60 * 1000);

  app.get('/api/backups/status', async (_req, res) => {
    const gCfg = await resolveGoogleServerConfig();
    res.json({
      ok: true,
      running: state.running,
      cronHourRd: state.cronHourRd,
      lastRunAt: state.lastRunAt,
      lastRunDateRd: state.lastRunDateRd,
      scheduledTestAt: state.scheduledTestAt,
      googleDriveMode: gCfg.hasServiceAccount
        ? 'service_account'
        : gCfg.hasRefreshToken
        ? 'oauth_refresh_token'
        : 'insforge_only',
      lastSummary: state.lastSummary
    });
  });

  app.post('/api/backups/schedule-test', (req, res) => {
    const delayMinutes = Math.max(1, Math.min(60, Number(req.body?.delayMinutes || 5)));
    const idempresa = req.body?.idempresa || null;
    if (testTimer) clearTimeout(testTimer);

    const runAt = new Date(Date.now() + delayMinutes * 60 * 1000).toISOString();
    state.scheduledTestAt = runAt;

    testTimer = setTimeout(() => {
      state.scheduledTestAt = null;
      testTimer = null;
      console.log(`[BackupCron] Ejecutando prueba programada (${delayMinutes} min)...`);
      runBackups({ idempresa, trigger: `scheduled_test_${delayMinutes}m` })
        .then((r) => console.log(`[BackupCron] Prueba finalizada: ${r.processed || 0} empresa(s)`))
        .catch((e) => console.error('[BackupCron] Error en prueba:', e.message));
    }, delayMinutes * 60 * 1000);

    res.json({
      ok: true,
      delayMinutes,
      scheduledTestAt: runAt,
      idempresa: idempresa || 'todas'
    });
  });

  app.post('/api/backups/google-exchange', async (req, res) => {
    try {
      const code = (req.body?.code || '').trim();
      if (!code) return res.status(400).json({ ok: false, error: 'Falta code de autorización de Google' });

      const gCfg = getGoogleServerConfig();
      if (!gCfg.clientId || !gCfg.clientSecret) {
        return res.status(500).json({ ok: false, error: 'Faltan GOOGLE_CLIENT_ID o GOOGLE_CLIENT_SECRET en el servidor' });
      }

      const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code,
          client_id: gCfg.clientId,
          client_secret: gCfg.clientSecret,
          redirect_uri: 'postmessage',
          grant_type: 'authorization_code'
        })
      });
      const tokenData = await tokenRes.json();
      if (!tokenRes.ok || !tokenData.refresh_token) {
        return res.status(400).json({
          ok: false,
          error: tokenData.error_description || tokenData.error || 'Google no devolvió refresh_token (intenta de nuevo aceptando el acceso offline).'
        });
      }

      await insforgeFetch('admin_integraciones?on_conflict=servicio', {
        method: 'POST',
        headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify([{
          servicio: 'google_drive_server',
          nombre: 'Google Drive Cron 24/7',
          tipo: 'cloud_storage',
          activo: true,
          config: {
            refresh_token: tokenData.refresh_token,
            updated_at: new Date().toISOString()
          }
        }])
      });

      res.json({ ok: true, connected: true, googleDriveMode: 'oauth_refresh_token' });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.post('/api/backups/run', async (req, res) => {
    try {
      const result = await runBackups({
        idempresa: req.body?.idempresa || null,
        trigger: 'manual_api'
      });
      res.json(result);
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });
}
