/*
  Painel RH - player da TV.

  Escrito em ES5 de propósito (var, function, XMLHttpRequest, sem ?. / async / arrow):
  navegadores de TV antigos (webOS/Tizen até ~2021) não entendem sintaxe nova e,
  com um único erro de sintaxe, o arquivo inteiro deixa de rodar.

  Diagnóstico na TV (sem console): abra a página com ?debug=1.
*/
(function () {
  'use strict';

  var videoPlayer = document.getElementById('videoPlayer');
  var imageViewer = document.getElementById('imageViewer');

  var REFRESH_INTERVAL = 30000;   // fallback da playlist se o SSE não funcionar
  var IMAGE_DURATION = 10000;     // tempo de cada imagem
  var ERROR_SKIP_DELAY = 3000;    // espera antes de pular uma mídia com erro
  var WATCHDOG_INTERVAL = 5000;   // de quanto em quanto tempo confere se o vídeo andou
  var STALL_TIMEOUT = 20000;      // vídeo parado (ou que não começou) por esse tempo = pula

  var playlist = [];
  var playlistHash = '';
  var currentIndex = 0;
  var currentSrc = '';
  var imageTimeout = null;
  var skipTimeout = null;

  var lastVideoTime = -1;
  var lastProgressAt = 0;

  /* ------------------------------------------------------------------ debug */

  var debugEnabled = /[?&]debug=1/.test(window.location.search);
  var debugBox = null;
  var debugLines = [];

  if (debugEnabled) {
    debugBox = document.createElement('pre');
    debugBox.style.cssText =
      'position:absolute;top:0;left:0;right:0;z-index:99;margin:0;padding:8px;' +
      'max-height:45%;overflow:hidden;background:rgba(0,0,0,.75);color:#0f0;' +
      'font:12px/1.3 monospace;white-space:pre-wrap;';
    document.body.appendChild(debugBox);
  }

  function log(msg) {
    var line = new Date().toTimeString().substr(0, 8) + ' ' + msg;

    if (window.console && console.log) {
      console.log(line);
    }

    if (debugBox) {
      debugLines.push(line);
      if (debugLines.length > 25) debugLines.shift();
      debugBox.textContent = debugLines.join('\n');
    }
  }

  window.onerror = function (message, source, line) {
    log('[ERRO JS] ' + message + ' (' + source + ':' + line + ')');
  };

  /* ------------------------------------------------------------------ API */

  function getJSON(url, onSuccess, onError) {
    var xhr = new XMLHttpRequest();
    var sep = url.indexOf('?') >= 0 ? '&' : '?';

    xhr.open('GET', url + sep + 'ts=' + Date.now(), true);
    xhr.timeout = 15000;

    xhr.onload = function () {
      if (xhr.status < 200 || xhr.status >= 300) {
        onError(new Error('HTTP ' + xhr.status));
        return;
      }

      try {
        onSuccess(JSON.parse(xhr.responseText));
      } catch (e) {
        onError(e);
      }
    };

    xhr.onerror = function () { onError(new Error('falha de rede')); };
    xhr.ontimeout = function () { onError(new Error('timeout')); };

    xhr.send();
  }

  function createPlaylistHash(items) {
    var parts = [];

    for (var i = 0; i < items.length; i++) {
      parts.push(items[i].name + '|' + items[i].src + '|' + items[i].size);
    }

    return parts.join(';');
  }

  function findIndexByName(items, name) {
    for (var i = 0; i < items.length; i++) {
      if (items[i].name === name) return i;
    }
    return -1;
  }

  function refreshPlaylist() {
    getJSON('/api/media', function (data) {
      if (!data || typeof data.length !== 'number') {
        log('[PLAYLIST] resposta inválida da API');
        return;
      }

      var newHash = createPlaylistHash(data);

      if (newHash === playlistHash) return;

      var currentItem = playlist[currentIndex];
      var wasEmpty = playlist.length === 0;

      playlist = data;
      playlistHash = newHash;

      log('[PLAYLIST] ' + playlist.length + ' mídia(s)');

      if (!playlist.length) {
        currentIndex = 0;
        hidePlayers();
        return;
      }

      var sameIndex = currentItem ? findIndexByName(playlist, currentItem.name) : -1;

      // O item atual continua na lista e não mudou: segue tocando, só ajusta o índice.
      if (!wasEmpty && sameIndex >= 0 && playlist[sameIndex].src === currentItem.src) {
        currentIndex = sameIndex;
        preloadNextImage();
        return;
      }

      // Primeira carga, ou o item atual foi removido/substituído: (re)começa.
      currentIndex = sameIndex >= 0 ? sameIndex : 0;
      showMedia(currentIndex);
    }, function (err) {
      log('[PLAYLIST] erro: ' + err.message);
    });
  }

  /* ------------------------------------------------------------------ player */

  function clearTimers() {
    clearTimeout(imageTimeout);
    clearTimeout(skipTimeout);
    imageTimeout = null;
    skipTimeout = null;
  }

  function showMedia(index) {
    clearTimers();

    var item = playlist[index];

    if (!item) return;

    if (item.type === 'video') {
      showVideo(item);
    } else {
      showImage(item);
    }

    preloadNextImage();
  }

  function showVideo(item) {
    imageViewer.style.display = 'none';
    imageViewer.removeAttribute('src');

    videoPlayer.style.display = 'block';
    videoPlayer.muted = true;
    videoPlayer.volume = 0;

    if (currentSrc !== item.src) {
      currentSrc = item.src;
      videoPlayer.src = item.src;
      videoPlayer.load();
    } else {
      // Mesmo vídeo de novo (ex.: playlist com um vídeo só): volta para o início.
      try { videoPlayer.currentTime = 0; } catch (e) { /* ignora */ }
    }

    lastVideoTime = -1;
    lastProgressAt = Date.now();

    log('[VIDEO] ' + item.name);
    tryPlay(item);
  }

  function tryPlay(item) {
    var p;

    try {
      p = videoPlayer.play();
    } catch (e) {
      log('[VIDEO] play() falhou: ' + e.message);
      return;
    }

    // Navegadores antigos não devolvem Promise; o watchdog cobre esse caso.
    if (p && typeof p.then === 'function') {
      p.then(null, function (err) {
        log('[VIDEO] autoplay recusado (' + item.name + '): ' + (err && err.name));
        // Uma nova tentativa; se não andar, o watchdog pula.
        setTimeout(function () {
          if (currentSrc === item.src) {
            var p2 = videoPlayer.play();
            if (p2 && typeof p2.then === 'function') p2.then(null, function () {});
          }
        }, 1000);
      });
    }
  }

  function showImage(item) {
    stopVideo();

    imageViewer.style.display = 'block';
    imageViewer.src = item.src;

    log('[IMAGEM] ' + item.name);

    imageTimeout = setTimeout(nextMedia, IMAGE_DURATION);
  }

  function stopVideo() {
    try { videoPlayer.pause(); } catch (e) { /* ignora */ }

    if (currentSrc) {
      videoPlayer.removeAttribute('src');
      // Libera o decodificador de hardware da TV.
      try { videoPlayer.load(); } catch (e) { /* ignora */ }
      currentSrc = '';
    }

    videoPlayer.style.display = 'none';
  }

  function hidePlayers() {
    clearTimers();
    stopVideo();
    imageViewer.removeAttribute('src');
    imageViewer.style.display = 'none';
  }

  function nextMedia() {
    if (!playlist.length) return;

    currentIndex = (currentIndex + 1) % playlist.length;
    showMedia(currentIndex);
  }

  // Um único pulo agendado por vez (erro + watchdog não pulam duas mídias).
  function scheduleSkip(reason) {
    if (skipTimeout) return;

    log('[SKIP] ' + reason);
    skipTimeout = setTimeout(function () {
      skipTimeout = null;
      nextMedia();
    }, ERROR_SKIP_DELAY);
  }

  /*
    Só pré-carrega imagem. Vídeo NÃO: um segundo <video> carregando
    disputa o decodificador de hardware da TV com o vídeo que está tocando.
    O cache do servidor/IIS já deixa a troca de vídeo rápida.
  */
  function preloadNextImage() {
    if (playlist.length < 2) return;

    var next = playlist[(currentIndex + 1) % playlist.length];

    if (next && next.type === 'image') {
      var img = new Image();
      img.src = next.src;
    }
  }

  /* ------------------------------------------------------------------ eventos do vídeo */

  videoPlayer.addEventListener('ended', function () {
    nextMedia();
  });

  videoPlayer.addEventListener('error', function () {
    if (!currentSrc) return; // erro de quando o src foi removido

    var err = videoPlayer.error;
    var codes = { 1: 'ABORTED', 2: 'NETWORK', 3: 'DECODE', 4: 'SRC_NOT_SUPPORTED' };

    scheduleSkip('erro no vídeo: ' + (err ? (codes[err.code] || err.code) : '?') +
      (err && err.code >= 3 ? ' (provável codec não suportado pela TV)' : ''));
  });

  videoPlayer.addEventListener('playing', function () {
    lastProgressAt = Date.now();
  });

  imageViewer.addEventListener('error', function () {
    if (imageViewer.getAttribute('src')) {
      scheduleSkip('erro na imagem: ' + imageViewer.getAttribute('src'));
    }
  });

  // Watchdog: vídeo que travou ou nunca começou é pulado.
  setInterval(function () {
    if (!currentSrc || skipTimeout) return;

    var t = videoPlayer.currentTime;

    if (t !== lastVideoTime) {
      lastVideoTime = t;
      lastProgressAt = Date.now();
      return;
    }

    if (Date.now() - lastProgressAt > STALL_TIMEOUT) {
      scheduleSkip('vídeo parado há ' + Math.round(STALL_TIMEOUT / 1000) + 's (readyState=' +
        videoPlayer.readyState + ', networkState=' + videoPlayer.networkState + ')');
    }
  }, WATCHDOG_INTERVAL);

  /* ------------------------------------------------------------------ atualização automática */

  function startMediaEvents() {
    if (!window.EventSource) {
      log('[SSE] não suportado; usando só o intervalo');
      return;
    }

    var es = new EventSource('/api/media/events');

    es.onmessage = function (event) {
      var data;

      try { data = JSON.parse(event.data); } catch (e) { return; }

      if (data.type === 'MEDIA_UPDATED') {
        log('[SSE] pasta de mídia alterada');
        refreshPlaylist();
      }
    };

    es.onerror = function () {
      // O EventSource reconecta sozinho; o intervalo continua como fallback.
    };
  }

  /* ------------------------------------------------------------------ início */

  function start() {
    log('[INIT] ' + navigator.userAgent);

    refreshPlaylist();
    startMediaEvents();
    setInterval(refreshPlaylist, REFRESH_INTERVAL);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
