// ============================================
// DrawStop — Configuração compartilhada do Supabase
// Inclua este script em TODAS as páginas do site, ANTES de qualquer outro script,
// usando os dois links abaixo no <head> ou antes do </body>:
//
// <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.js"></script>
// <script src="drawstop-supabase.js"></script>
// ============================================

const DRAWSTOP_SUPABASE_URL = 'https://gfjafxpkvmpzqqyoviuj.supabase.co';
const DRAWSTOP_SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImdmamFmeHBrdm1wenFxeW92aXVqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODgwNDkxODMsImV4cCI6MjEwMzYyNTE4M30.w3RPLGTKXFOsBu280dBGNnp09Df4D-Kvps4K3egfQ6U';

// Cliente global do Supabase, disponível em todas as páginas como `dsClient`
const dsClient = supabase.createClient(DRAWSTOP_SUPABASE_URL, DRAWSTOP_SUPABASE_ANON_KEY);

// ============================================
// Helpers de autenticação usados em várias páginas
// ============================================

// Retorna a sessão atual (ou null se não estiver logado)
async function dsGetSession() {
  const { data: { session } } = await dsClient.auth.getSession();
  return session;
}

// Retorna o perfil completo (tabela profiles) do usuário logado
async function dsGetProfile() {
  const session = await dsGetSession();
  if (!session) return null;

  const { data, error } = await dsClient
    .from('profiles')
    .select('*')
    .eq('id', session.user.id)
    .single();

  if (error) {
    console.error('Erro ao buscar perfil:', error);
    return null;
  }
  return data;
}

// Protege uma página: se não estiver logado, redireciona para o login.
// Também verifica se o usuário está banido e, se estiver, bloqueia o acesso.
async function dsRequireAuth() {
  const session = await dsGetSession();
  if (!session) {
    window.location.href = 'login.html';
    return null;
  }

  let banInfo = null;
  try {
    const result = await dsClient.rpc('is_currently_banned', { user_id_input: session.user.id });
    banInfo = result.data;
  } catch (e) {
    console.error('Erro ao checar banimento (ignorado):', e);
  }
  if (banInfo && banInfo.length > 0 && banInfo[0].banned) {
    const until = banInfo[0].banned_until
      ? 'até ' + new Date(banInfo[0].banned_until).toLocaleString('pt-BR')
      : 'permanentemente';
    alert(`🚫 Sua conta está banida ${until}.\nMotivo: ${banInfo[0].reason}`);
    await dsClient.auth.signOut();
    window.location.href = 'login.html';
    return null;
  }

  // Checa se um ADM forçou logout desde a última vez
  try {
    const { data: profileCheck } = await dsClient.from('profiles').select('force_logout_at').eq('id', session.user.id).single();
    const lastForced = localStorage.getItem('drawstop_last_forced_logout_' + session.user.id);
    if (profileCheck && profileCheck.force_logout_at && profileCheck.force_logout_at !== lastForced) {
      localStorage.setItem('drawstop_last_forced_logout_' + session.user.id, profileCheck.force_logout_at);
      await dsClient.auth.signOut();
      window.location.href = 'login.html';
      return null;
    }
  } catch (e) { /* ignorado */ }

  // Checa se o modo manutenção está ativo (bloqueia quem não é ADM)
  try {
    const { data: settings } = await dsClient.from('site_settings').select('maintenance_mode, maintenance_message').single();
    if (settings && settings.maintenance_mode) {
      const { data: adminCheck } = await dsClient.from('profiles').select('admin_level, admin_expires_at').eq('id', session.user.id).single();
      const isAdminNow = adminCheck && adminCheck.admin_level > 0 && (!adminCheck.admin_expires_at || new Date(adminCheck.admin_expires_at) > new Date());
      if (!isAdminNow) {
        alert('🔧 ' + settings.maintenance_message);
        await dsClient.auth.signOut();
        window.location.href = 'login.html';
        return null;
      }
    }
  } catch (e) { /* ignorado */ }

  dsStartHeartbeat();
  return session;
}

// ============================================
// Heartbeat — detecção real de online. Toda página autenticada "bate o coração"
// a cada 30s; se parar de bater por mais de 2 minutos, o jogador é tratado como
// offline de verdade, mesmo que o campo "status" antigo não tenha sido atualizado
// (ex: fechou a aba sem clicar em sair).
// ============================================
let _dsHeartbeatStarted = false;
function dsStartHeartbeat() {
  if (_dsHeartbeatStarted) return;
  _dsHeartbeatStarted = true;
  dsClient.rpc('heartbeat').catch(() => {});
  setInterval(() => { dsClient.rpc('heartbeat').catch(() => {}); }, 30000);
}

// Considera offline se o último heartbeat foi há mais de 2 minutos, mesmo que o
// campo "status" diga outra coisa (aba fechada sem avisar, conexão perdida, etc.)
function dsRealStatus(profile) {
  if (!profile.last_seen_at) return 'offline';
  const diffMs = Date.now() - new Date(profile.last_seen_at).getTime();
  if (diffMs > 2 * 60 * 1000) return 'offline';
  return profile.status || 'offline';
}

// Atualiza o status (online/offline/ingame) do usuário logado
async function dsSetStatus(status) {
  const session = await dsGetSession();
  if (!session) return;
  await dsClient.from('profiles').update({ status }).eq('id', session.user.id);
}

// Logout
async function dsLogout() {
  await dsSetStatus('offline');
  await dsClient.auth.signOut();
  window.location.href = 'login.html';
}

// ============================================
// Notificações
// ============================================
async function dsSendNotification(userId, type, title, body, link) {
  await dsClient.from('notifications').insert({ user_id: userId, type, title, body, link });
}

async function dsGetUnreadCount(userId) {
  const { count } = await dsClient.from('notifications').select('*', { count: 'exact', head: true }).eq('user_id', userId).eq('is_read', false);
  return count || 0;
}

// Retorna as preferências de notificação do perfil (com fallback padrão)
function dsNotifPref(profile, key) {
  return profile.settings ? profile.settings[key] !== false : true;
}

// ============================================
// Música ambiente calma — gerada ao vivo com Web Audio API (nenhum arquivo externo necessário).
// Usa alguns tons suaves e lentos sobrepostos, tipo um "pad" relaxante de fundo.
// ============================================
let _dsAmbientCtx = null;
let _dsAmbientNodes = [];

function dsPlayAmbientMusic(volume) {
  dsStopAmbientMusic();
  try {
    _dsAmbientCtx = new (window.AudioContext || window.webkitAudioContext)();
    const notes = [130.81, 164.81, 196.00, 246.94]; // C3, E3, G3, B3 — acorde suave
    const masterGain = _dsAmbientCtx.createGain();
    masterGain.gain.value = Math.max(0, Math.min(1, volume)) * 0.06; // bem baixinho, ambiente
    masterGain.connect(_dsAmbientCtx.destination);

    notes.forEach((freq, i) => {
      const osc = _dsAmbientCtx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = freq;

      const lfo = _dsAmbientCtx.createOscillator();
      lfo.frequency.value = 0.05 + i * 0.02; // variação bem lenta no volume, efeito "respirando"
      const lfoGain = _dsAmbientCtx.createGain();
      lfoGain.gain.value = 0.4;
      lfo.connect(lfoGain);

      const noteGain = _dsAmbientCtx.createGain();
      noteGain.gain.value = 0.6;
      lfoGain.connect(noteGain.gain);

      osc.connect(noteGain);
      noteGain.connect(masterGain);
      osc.start();
      lfo.start();
      _dsAmbientNodes.push(osc, lfo);
    });
  } catch (e) {
    console.warn('Música ambiente indisponível neste navegador:', e);
  }
}

function dsStopAmbientMusic() {
  _dsAmbientNodes.forEach(n => { try { n.stop(); } catch (e) {} });
  _dsAmbientNodes = [];
  if (_dsAmbientCtx) { try { _dsAmbientCtx.close(); } catch (e) {} _dsAmbientCtx = null; }
}

// ============================================
// Fundos animados de ADM — com partículas de verdade (não só gradiente estático)
// ============================================
function dsRenderAnimatedBackground(layerEl, bgType) {
  if (!layerEl) return;
  layerEl.innerHTML = '';
  layerEl.className = 'ds-anim-layer';
  if (!bgType || bgType === 'none') return;

  layerEl.classList.add('ds-anim-' + bgType);

  function rand(min, max) { return Math.random() * (max - min) + min; }

  if (bgType === 'stars' || bgType === 'galaxy') {
    for (let i = 0; i < 40; i++) {
      const star = document.createElement('div');
      star.className = 'ds-star';
      star.style.left = rand(0, 100) + '%';
      star.style.top = rand(0, 100) + '%';
      star.style.width = star.style.height = rand(1, 3) + 'px';
      star.style.animationDelay = rand(0, 4) + 's';
      star.style.animationDuration = rand(2, 5) + 's';
      layerEl.appendChild(star);
    }
  }

  if (bgType === 'fire') {
    for (let i = 0; i < 18; i++) {
      const ember = document.createElement('div');
      ember.className = 'ds-ember';
      ember.style.left = rand(0, 100) + '%';
      ember.style.animationDelay = rand(0, 3) + 's';
      ember.style.animationDuration = rand(2.5, 4.5) + 's';
      ember.style.setProperty('--drift', rand(-20, 20) + 'px');
      layerEl.appendChild(ember);
    }
  }

  if (bgType === 'aurora') {
    for (let i = 0; i < 3; i++) {
      const band = document.createElement('div');
      band.className = 'ds-aurora-band ds-aurora-band-' + i;
      layerEl.appendChild(band);
    }
  }

  if (bgType === 'ocean') {
    for (let i = 0; i < 3; i++) {
      const wave = document.createElement('div');
      wave.className = 'ds-wave ds-wave-' + i;
      layerEl.appendChild(wave);
    }
  }

  if (bgType === 'sparkle') {
    for (let i = 0; i < 25; i++) {
      const sp = document.createElement('div');
      sp.className = 'ds-sparkle';
      sp.style.left = rand(0, 100) + '%';
      sp.style.top = rand(0, 100) + '%';
      sp.style.animationDelay = rand(0, 3) + 's';
      layerEl.appendChild(sp);
    }
  }

  if (bgType === 'matrix') {
    for (let i = 0; i < 14; i++) {
      const col = document.createElement('div');
      col.className = 'ds-matrix-col';
      col.style.left = (i * (100 / 14)) + '%';
      col.style.animationDelay = rand(0, 3) + 's';
      col.style.animationDuration = rand(2, 4) + 's';
      layerEl.appendChild(col);
    }
  }
}

const DS_ADMIN_BG_STYLES = `
.ds-anim-layer { position:absolute; inset:0; overflow:hidden; pointer-events:none; z-index:1; }

.ds-anim-glow { background: radial-gradient(circle, rgba(255,255,255,.35), transparent 70%); animation: dsGlowPulse 2.5s ease-in-out infinite; }
@keyframes dsGlowPulse { 0%,100%{ opacity:.5; transform:scale(1); } 50%{ opacity:1; transform:scale(1.15); } }

.ds-anim-stars, .ds-anim-galaxy { background: radial-gradient(ellipse at 30% 20%, rgba(142,68,173,.55), transparent 60%), radial-gradient(ellipse at 70% 80%, rgba(41,128,185,.5), transparent 60%), #0a0a1a; }
.ds-star { position:absolute; background:#fff; border-radius:50%; animation: dsTwinkle ease-in-out infinite; box-shadow:0 0 4px 1px rgba(255,255,255,.8); }
@keyframes dsTwinkle { 0%,100%{ opacity:.2; transform:scale(.8); } 50%{ opacity:1; transform:scale(1.4); } }

.ds-anim-fire { background: linear-gradient(0deg, #7a1a00, #ff6a00 60%, #ffcf4d); }
.ds-ember { position:absolute; bottom:-10px; width:4px; height:4px; border-radius:50%; background:radial-gradient(circle, #fff6c8, #ff8a00); animation: dsEmberRise linear infinite; }
@keyframes dsEmberRise { 0%{ transform:translate(0,0) scale(1); opacity:1; } 100%{ transform:translate(var(--drift), -160px) scale(.2); opacity:0; } }

.ds-anim-aurora { background:#061018; }
.ds-aurora-band { position:absolute; left:-20%; width:140%; height:60%; border-radius:50%; filter:blur(18px); opacity:.55; mix-blend-mode:screen; animation: dsAuroraFlow ease-in-out infinite; }
.ds-aurora-band-0 { top:-10%; background:linear-gradient(90deg,#00e5a0,#00c6ff); animation-duration:7s; }
.ds-aurora-band-1 { top:15%; background:linear-gradient(90deg,#7b2ff7,#00e5a0); animation-duration:9s; animation-delay:1s; }
.ds-aurora-band-2 { top:35%; background:linear-gradient(90deg,#00c6ff,#7b2ff7); animation-duration:11s; animation-delay:2s; }
@keyframes dsAuroraFlow { 0%,100%{ transform:translateX(-6%) translateY(0); } 50%{ transform:translateX(6%) translateY(10px); } }

.ds-anim-ocean { background: linear-gradient(180deg,#003554,#00527a); }
.ds-wave { position:absolute; left:-10%; width:120%; height:40px; border-radius:45%; background:rgba(255,255,255,.18); animation: dsWaveMove ease-in-out infinite; }
.ds-wave-0 { bottom:10px; animation-duration:4s; }
.ds-wave-1 { bottom:0px; opacity:.7; animation-duration:5.5s; animation-delay:.5s; }
.ds-wave-2 { bottom:-10px; opacity:.5; animation-duration:7s; animation-delay:1s; }
@keyframes dsWaveMove { 0%,100%{ transform:translateX(0) scaleY(1); } 50%{ transform:translateX(4%) scaleY(1.3); } }

.ds-anim-sparkle { background: linear-gradient(135deg,#2b0a3d,#5a1e8f); }
.ds-sparkle { position:absolute; width:6px; height:6px; background:#fff; clip-path:polygon(50% 0%,61% 35%,100% 50%,61% 65%,50% 100%,39% 65%,0% 50%,39% 35%); animation: dsSparklePulse 2s ease-in-out infinite; }
@keyframes dsSparklePulse { 0%,100%{ opacity:0; transform:scale(.3) rotate(0deg); } 50%{ opacity:1; transform:scale(1.1) rotate(90deg); } }

.ds-anim-matrix { background:#000; }
.ds-matrix-col { position:absolute; top:-100%; width:2px; height:100%; background:linear-gradient(180deg, transparent, #00ff6a, transparent); animation: dsMatrixFall linear infinite; }
@keyframes dsMatrixFall { 0%{ transform:translateY(0); } 100%{ transform:translateY(200%); } }
`;

// Injeta os estilos das animações uma única vez por página
(function dsInjectAdminBgStyles() {
  if (document.getElementById('ds-admin-bg-styles')) return;
  const style = document.createElement('style');
  style.id = 'ds-admin-bg-styles';
  style.innerText = DS_ADMIN_BG_STYLES;
  document.head.appendChild(style);
})();

// ============================================
// Tags de Top 10 — SEMPRE calculadas ao vivo (nunca guardadas), então mudam sozinhas
// ============================================
const DS_MODE_LABELS = { gartic: 'Draw', stop: 'Stop', stopdesenhado: 'DrawStop' };

async function dsGetLiveRankTags(profileId) {
  const { data } = await dsClient.rpc('get_player_leaderboard_ranks', { pid: profileId });
  if (!data) return [];
  return data.filter(r => r.rank <= 10).map(r => ({
    mode: r.mode,
    rank: r.rank,
    label: `Top ${r.rank} ${DS_MODE_LABELS[r.mode] || r.mode}`
  }));
}

// Desbloqueia uma conquista (silenciosamente ignora se já desbloqueada)
async function dsUnlockAchievement(profileId, achievementId) {
  try {
    await dsClient.from('user_achievements').insert({ profile_id: profileId, achievement_id: achievementId });
  } catch (e) { /* já desbloqueada ou erro silencioso */ }
}

// ============================================
// Sistema de níveis de ADM
// ============================================
const DS_ADMIN_LEVELS = { 1: 'Moderador', 2: 'Administrador', 3: 'Diretor Supremo', 4: 'CEO', 5: 'Dono' };

// Verifica no PRÓPRIO objeto de perfil já carregado se o ADM está ativo (considera expiração)
function dsIsAdminActive(profile) {
  if (!profile || !profile.admin_level || profile.admin_level <= 0) return false;
  if (!profile.admin_expires_at) return true;
  return new Date(profile.admin_expires_at) > new Date();
}
