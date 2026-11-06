const videoPlayer = document.getElementById('videoPlayer');
const imageViewer = document.getElementById('imageViewer');

let playlist = [];
let currentIndex = 0;
let imageTimeout = null;
let playlistHash = '';
let eventSource = null;

let nextVideoPreload = null;

const REFRESH_INTERVAL = 30000;
const IMAGE_DURATION = 10000;
const ERROR_SKIP_DELAY = 3000;

async function fetchPlaylist() {
  const response = await fetch(`/api/media?ts=${Date.now()}`, {
    cache: 'no-store'
  });

  if (!response.ok) {
    throw new Error(`Erro HTTP: ${response.status}`);
  }

  const data = await response.json();

  if (!Array.isArray(data)) {
    throw new Error('Resposta inválida da API /api/media');
  }

  return data;
}

async function loadPlaylist() {
  try {
    playlist = await fetchPlaylist();
    playlistHash = createPlaylistHash(playlist);

    if (!playlist.length) {
      console.warn('Nenhuma mídia encontrada');
      hidePlayers();
      return;
    }

    currentIndex = 0;
    showMedia(currentIndex);
  } catch (error) {
    console.error('Erro ao carregar mídias:', error);
    hidePlayers();
  }
}

async function refreshPlaylist(forceReloadCurrent = false) {
  try {
    const newPlaylist = await fetchPlaylist();
    const newHash = createPlaylistHash(newPlaylist);

    if (newHash === playlistHash) {
      return;
    }

    const currentItemName = playlist[currentIndex]?.name;

    playlist = newPlaylist;
    playlistHash = newHash;

    if (!playlist.length) {
      console.warn('Playlist vazia após atualização');
      currentIndex = 0;
      hidePlayers();
      return;
    }

    const sameItemIndex = playlist.findIndex(
      (item) => item.name === currentItemName
    );

    currentIndex = sameItemIndex >= 0 ? sameItemIndex : 0;

    console.log('Playlist atualizada automaticamente');

    preloadNextMedia();

    if (forceReloadCurrent || sameItemIndex < 0) {
      showMedia(currentIndex);
    }
  } catch (error) {
    console.error('Erro ao atualizar playlist:', error);
  }
}

function createPlaylistHash(items) {
  return JSON.stringify(
    items.map((item) => {
      return `${item.name}|${item.type}|${item.src}|${item.modifiedAt}|${item.size}`;
    })
  );
}

function showMedia(index) {
  clearTimeout(imageTimeout);

  const item = playlist[index];

  if (!item) {
    console.warn('Mídia não encontrada');
    return;
  }

  if (item.type === 'video') {
    showVideo(item);
  } else {
    showImage(item);
  }

  preloadNextMedia();
}

function showVideo(item) {
  clearTimeout(imageTimeout);

  imageViewer.style.display = 'none';
  imageViewer.removeAttribute('src');

  videoPlayer.style.display = 'block';

  videoPlayer.muted = true;
  videoPlayer.volume = 0;
  videoPlayer.autoplay = true;
  videoPlayer.playsInline = true;
  videoPlayer.preload = 'auto';

  if (videoPlayer.src !== new URL(item.src, window.location.origin).href) {
    videoPlayer.src = item.src;
  }

  const playPromise = videoPlayer.play();

  if (playPromise !== undefined) {
    playPromise
      .then(() => {
        console.log(`[VIDEO] Reproduzindo automaticamente: ${item.name}`);
      })
      .catch((error) => {
        console.warn(`[VIDEO] Falha no autoplay: ${item.name}`, error);

        setTimeout(() => {
          videoPlayer
            .play()
            .catch(() => {
              setTimeout(nextMedia, ERROR_SKIP_DELAY);
            });
        }, 1000);
      });
  }
}

function showImage(item) {
  clearTimeout(imageTimeout);

  videoPlayer.pause();
  videoPlayer.removeAttribute('src');
  videoPlayer.style.display = 'none';

  imageViewer.style.display = 'block';
  imageViewer.src = item.src;

  imageTimeout = setTimeout(() => {
    nextMedia();
  }, IMAGE_DURATION);
}

function hidePlayers() {
  clearTimeout(imageTimeout);

  videoPlayer.pause();
  videoPlayer.removeAttribute('src');
  videoPlayer.style.display = 'none';

  imageViewer.removeAttribute('src');
  imageViewer.style.display = 'none';

  if (nextVideoPreload) {
    nextVideoPreload.removeAttribute('src');
    nextVideoPreload = null;
  }
}

function nextMedia() {
  if (!playlist.length) return;

  currentIndex = (currentIndex + 1) % playlist.length;

  showMedia(currentIndex);
}

function preloadNextMedia() {
  if (!playlist.length) return;

  const nextIndex = (currentIndex + 1) % playlist.length;
  const nextItem = playlist[nextIndex];

  if (!nextItem) return;

  if (nextItem.type === 'video') {
    preloadVideo(nextItem);
    return;
  }

  preloadImage(nextItem);
}

function preloadVideo(item) {
  if (nextVideoPreload) {
    nextVideoPreload.pause();
    nextVideoPreload.removeAttribute('src');
    nextVideoPreload = null;
  }

  nextVideoPreload = document.createElement('video');

  nextVideoPreload.preload = 'auto';
  nextVideoPreload.muted = true;
  nextVideoPreload.playsInline = true;
  nextVideoPreload.src = item.src;

  nextVideoPreload.load();

  nextVideoPreload.addEventListener(
    'canplay',
    () => {
      console.log(`[PRELOAD] Próximo vídeo preparado: ${item.name}`);
    },
    { once: true }
  );
}

function preloadImage(item) {
  const img = new Image();

  img.src = item.src;

  img.onload = () => {
    console.log(`[PRELOAD] Próxima imagem preparada: ${item.name}`);
  };
}

function startMediaEvents() {
  if (!window.EventSource) {
    console.warn('EventSource não suportado neste navegador.');
    return;
  }

  eventSource = new EventSource('/api/media/events');

  eventSource.onopen = () => {
    console.log('Monitoramento de mídia conectado.');
  };

  eventSource.onmessage = async (event) => {
    try {
      const data = JSON.parse(event.data);

      if (data.type === 'MEDIA_UPDATED') {
        console.log('Alteração detectada na pasta de mídia.');

        await refreshPlaylist(false);
      }
    } catch (error) {
      console.error('Erro ao processar evento de mídia:', error);
    }
  };

  eventSource.onerror = () => {
    console.warn(
      'Conexão de eventos perdida. O fallback por intervalo continuará ativo.'
    );
  };
}

videoPlayer.addEventListener('ended', nextMedia);

videoPlayer.addEventListener('error', () => {
  console.error('Erro ao carregar vídeo:', videoPlayer.error);

  setTimeout(nextMedia, ERROR_SKIP_DELAY);
});

imageViewer.addEventListener('error', () => {
  console.error('Erro ao carregar imagem:', imageViewer.src);

  setTimeout(nextMedia, ERROR_SKIP_DELAY);
});

document.addEventListener('DOMContentLoaded', () => {
  loadPlaylist();

  startMediaEvents();

  setInterval(() => {
    refreshPlaylist(false);
  }, REFRESH_INTERVAL);
});