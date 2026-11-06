const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();

const PORT = process.env.PORT || 8000;

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
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');

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

      return fs.createReadStream(filePath).pipe(res);
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

      return fs.createReadStream(filePath).pipe(res);
    }

    const match = range.match(/bytes=(\d*)-(\d*)/);

    if (!match) {
      res.status(416);
      res.setHeader('Content-Range', `bytes */${fileSize}`);
      return res.end();
    }

    let start = match[1] ? parseInt(match[1], 10) : 0;
    let end = match[2]
      ? parseInt(match[2], 10)
      : fileSize - 1;

    if (Number.isNaN(start)) {
      start = 0;
    }

    if (Number.isNaN(end)) {
      end = fileSize - 1;
    }

    if (start >= fileSize || end >= fileSize || start > end) {
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

    const stream = fs.createReadStream(filePath, {
      start,
      end
    });

    stream.on('error', (error) => {
      console.error('[VIDEO] Erro no stream:', error);

      if (!res.headersSent) {
        res.status(500).end();
      } else {
        res.destroy();
      }
    });

    return stream.pipe(res);
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

  res.flushHeaders?.();

  res.write(
    `data: ${JSON.stringify({
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
    client.write(`data: ${payload}\n\n`);
  });
}

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

app.listen(PORT, '0.0.0.0', () => {
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