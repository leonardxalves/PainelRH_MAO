const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();

const PORT = process.env.PORT || 8000;
// Atrás do IIS, use HOST=127.0.0.1 para o Node não ficar exposto na rede.
const HOST = process.env.HOST || '0.0.0.0';

const publicPath = path.join(__dirname, 'public');
const mediaFolderName = 'videos_mao';
const videosPath = path.join(publicPath, mediaFolderName);

let clients = [];

function getContentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();

  const types = {
    '.mp4': 'video/mp4',
    '.webm': 'video/webm',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.webp': 'image/webp'
  };

  return types[ext] || 'application/octet-stream';
}

function pipeFile(res, filePath, options) {
  const stream = fs.createReadStream(filePath, options);

  stream.on('error', (error) => {
    console.error('[MEDIA] Erro no stream:', error);
    if (!res.headersSent) {
      res.status(500).end();
    } else {
      res.destroy();
    }
  });

  // A TV cancela muitos pedidos no meio; sem isso o arquivo fica aberto.
  res.on('close', () => stream.destroy());

  return stream.pipe(res);
}

/*
|--------------------------------------------------------------------------
| ROTA ESPECÍFICA PARA MÍDIAS
|--------------------------------------------------------------------------
*/

app.get('/media/:filename', (req, res) => {
  try {
    const filename = path.basename(req.params.filename);
    const filePath = path.join(videosPath, filename);

    if (!fs.existsSync(filePath)) {
      return res.status(404).json({
        error: 'Arquivo não encontrado',
        filename
      });
    }

    const stat = fs.statSync(filePath);

    if (!stat.isFile()) {
      return res.status(404).end();
    }

    const fileSize = stat.size;
    const contentType = getContentType(filePath);

    res.setHeader('Content-Type', contentType);
    res.setHeader('Accept-Ranges', 'bytes');
    // A URL já leva ?v=<mtime>: arquivo trocado = URL nova. Com no-store a TV
    // baixava o vídeo inteiro de novo a cada volta da playlist.
    res.setHeader('Cache-Control', 'public, max-age=604800');

    const isVideo =
      contentType === 'video/mp4' ||
      contentType === 'video/webm';

    /*
    |--------------------------------------------------------------------------
    | IMAGENS
    |--------------------------------------------------------------------------
    */

    if (!isVideo) {
      res.setHeader('Content-Length', fileSize);

      return pipeFile(res, filePath);
    }

    /*
    |--------------------------------------------------------------------------
    | VÍDEOS
    |--------------------------------------------------------------------------
    */

    const range = req.headers.range;

    if (!range) {
      res.status(200);

      res.setHeader('Content-Length', fileSize);

      return pipeFile(res, filePath);
    }

    // Só o primeiro intervalo (multi-range não é usado por players de vídeo).
    const match = range.match(/^bytes=(\d*)-(\d*)/);

    if (!match || (match[1] === '' && match[2] === '')) {
      res.status(416);
      res.setHeader('Content-Range', `bytes */${fileSize}`);
      return res.end();
    }

    let start;
    let end;

    if (match[1] === '') {
      // Sufixo "bytes=-N" = últimos N bytes (TVs usam para ler o moov no fim do MP4).
      const suffix = parseInt(match[2], 10);
      start = Math.max(fileSize - suffix, 0);
      end = fileSize - 1;
    } else {
      start = parseInt(match[1], 10);
      // Fim além do tamanho é válido pela RFC 7233: ajusta para o último byte.
      end = match[2] === ''
        ? fileSize - 1
        : Math.min(parseInt(match[2], 10), fileSize - 1);
    }

    if (start >= fileSize || start > end) {
      res.status(416);
      res.setHeader('Content-Range', `bytes */${fileSize}`);
      return res.end();
    }

    const chunkSize = end - start + 1;

    res.status(206);

    res.setHeader(
      'Content-Range',
      `bytes ${start}-${end}/${fileSize}`
    );

    res.setHeader('Content-Length', chunkSize);

    console.log(
      `[VIDEO] ${filename} | Range ${start}-${end}/${fileSize}`
    );

    return pipeFile(res, filePath, { start, end });
  } catch (error) {
    console.error('[MEDIA] Erro:', error);

    return res.status(500).json({
      error: 'Erro ao carregar mídia'
    });
  }
});

/*
|--------------------------------------------------------------------------
| ARQUIVOS ESTÁTICOS
|--------------------------------------------------------------------------
*/

app.use(
  express.static(publicPath, {
    etag: false,
    lastModified: false,
    maxAge: 0,
    setHeaders: (res) => {
      res.setHeader(
        'Cache-Control',
        'no-store, no-cache, must-revalidate, proxy-revalidate'
      );

      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
    }
  })
);

/*
|--------------------------------------------------------------------------
| LISTAGEM DAS MÍDIAS
|--------------------------------------------------------------------------
*/

function getMediaList() {
  if (!fs.existsSync(videosPath)) {
    return [];
  }

  const allowedExtensions = [
    '.mp4',
    '.webm',
    '.jpg',
    '.jpeg',
    '.png',
    '.webp'
  ];

  const videoExtensions = [
    '.mp4',
    '.webm'
  ];

  const files = fs.readdirSync(videosPath);

  return files
    .filter((file) => {
      const fullPath = path.join(videosPath, file);
      const ext = path.extname(file).toLowerCase();

      try {
        return (
          fs.statSync(fullPath).isFile() &&
          allowedExtensions.includes(ext)
        );
      } catch {
        return false;
      }
    })
    .map((file) => {
      const fullPath = path.join(videosPath, file);
      const stat = fs.statSync(fullPath);
      const ext = path.extname(file).toLowerCase();

      return {
        name: file,

        type: videoExtensions.includes(ext)
          ? 'video'
          : 'image',

        src: `/media/${encodeURIComponent(file)}?v=${Math.floor(
          stat.mtimeMs
        )}`,

        modifiedAt: stat.mtimeMs,
        size: stat.size
      };
    })
    .sort((a, b) =>
      a.name.localeCompare(b.name)
    );
}

/*
|--------------------------------------------------------------------------
| API
|--------------------------------------------------------------------------
*/

app.get('/api/media', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');

  if (!fs.existsSync(videosPath)) {
    return res.status(404).json({
      error: 'Pasta de mídias não encontrada',
      path: videosPath
    });
  }

  return res.json(getMediaList());
});

/*
|--------------------------------------------------------------------------
| SERVER SENT EVENTS
|--------------------------------------------------------------------------
*/

app.get('/api/media/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');

  if (typeof res.flushHeaders === 'function') {
    res.flushHeaders();
  }

  // retry: o navegador reconecta em 5 s se a conexão cair (ex.: timeout do proxy).
  res.write(
    `retry: 5000\ndata: ${JSON.stringify({
      type: 'CONNECTED'
    })}\n\n`
  );

  clients.push(res);

  req.on('close', () => {
    clients = clients.filter(
      (client) => client !== res
    );
  });
});

function notifyClients() {
  const payload = JSON.stringify({
    type: 'MEDIA_UPDATED',
    updatedAt: new Date().toISOString()
  });

  clients.forEach((client) => {
    try {
      client.write(`data: ${payload}\n\n`);
    } catch (error) {
      console.error('[SSE] Falha ao notificar cliente:', error.message);
    }
  });
}

// Comentário a cada 25 s: mantém a conexão viva em proxies (IIS/ARR) e
// derruba clientes mortos (a TV desligada não avisa que saiu).
setInterval(() => {
  clients.forEach((client) => {
    try {
      client.write(': ping\n\n');
    } catch {
      // o 'close' remove o cliente
    }
  });
}, 25000);

/*
|--------------------------------------------------------------------------
| WATCH
|--------------------------------------------------------------------------
*/

if (fs.existsSync(videosPath)) {
  let debounceTimer = null;

  fs.watch(
    videosPath,
    {
      persistent: true
    },
    () => {
      clearTimeout(debounceTimer);

      debounceTimer = setTimeout(() => {
        console.log(
          '[MEDIA] Pasta atualizada. Notificando clientes...'
        );

        notifyClients();
      }, 1000);
    }
  );
} else {
  console.warn(
    '[MEDIA] Pasta não encontrada:',
    videosPath
  );
}

/*
|--------------------------------------------------------------------------
| HEALTH
|--------------------------------------------------------------------------
*/

app.get('/health', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');

  res.json({
    status: 'online',
    app: 'Painel RH - Manaus',
    port: PORT,
    publicPath,
    videosPath
  });
});

/*
|--------------------------------------------------------------------------
| SERVER
|--------------------------------------------------------------------------
*/

app.listen(PORT, HOST, () => {
  console.log('====================================');

  console.log('Painel RH rodando em:');
  console.log(`http://localhost:${PORT}`);

  console.log(
    `API: http://localhost:${PORT}/api/media`
  );

  console.log(
    `Eventos: http://localhost:${PORT}/api/media/events`
  );

  console.log(
    `Health: http://localhost:${PORT}/health`
  );

  console.log(`Pasta pública: ${publicPath}`);
  console.log(`Pasta de mídias: ${videosPath}`);

  console.log('====================================');
});