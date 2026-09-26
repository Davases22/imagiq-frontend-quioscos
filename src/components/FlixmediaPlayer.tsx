/**
 * FlixmediaPlayer Component
 *
 * Usa la API de Match de Flixmedia para verificar contenido ANTES de cargar.
 * Si no hay contenido, redirige inmediatamente sin esperar.
 *
 * Telemetría: cada inicialización emite UN evento PostHog `flixmedia_result`
 * con `outcome` ∈ inpage_callback | content_detected | noshow_callback |
 * visual_error | loader_error | timeout_no_content | no_mpn, más mpn,
 * product_id, elapsed_ms, mode y si redirigió.
 */

"use client";

import { useEffect, memo, useCallback, useState, useRef } from "react";
import { parseSkuString, resolveFlixmediaMpn, checkFlixmediaAvailabilityByEan, hasPremiumContent as checkPremiumContent } from "@/lib/flixmedia";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { posthogUtils } from "@/lib/posthogClient";

declare global {
  interface Window {
    flixJsCallbacks?: {
      // Dual API: Flixmedia llama con (type) para notificar, o se registra con (fn, type)
      setLoadCallback: (typeOrFn: unknown, type?: string) => void;
      loadService: (type: string) => void;
      // pagedata-specific.js de Flixmedia lo invoca durante el render
      flixCartClick?: () => void;
    };
  }
}

interface FlixmediaPlayerProps {
  /**
   * MPN o lista de candidatos separados por coma, en orden de preferencia
   * (ver buildFlixmediaMpnCandidates). Con más de un candidato, el player
   * consulta el Match API (cacheado 24h en /api/flixmedia/match) y carga el
   * primero que tenga contenido; si ninguno matchea usa el primero.
   */
  mpn?: string | null;
  ean?: string | null;
  productName?: string;
  className?: string;
  productId?: string;
  segmento?: string | string[];
  // Cuando es true, no redirige si no hay contenido (para uso embebido)
  preventRedirect?: boolean;
  // Cuando es true, salta Match API y carga loader.js directo (mas rapido, para pagina multimedia)
  skipMatchApi?: boolean;
  // Información del producto para verificar contenido premium
  apiProduct?: {
    imagenPremium?: string[][];
    videoPremium?: string[][];
    imagen_premium?: string[][];
    video_premium?: string[][];
  };
  productColors?: Array<{
    imagen_premium?: string[];
    video_premium?: string[];
  }>;
}

const DISTRIBUTOR_ID = "17257";
const LANGUAGE = "f5";

// Ventana de "sin contenido": se cuenta desde que loader.js está LISTO (onload),
// no desde que se inyecta. Antes eran 4s desde la inyección: en una red/máquina
// lenta el propio loader + service.js + t.json consumían el presupuesto y la
// página expulsaba a view aunque Flixmedia SÍ tuviera contenido (S90F, M75H...).
// Los productos realmente sin contenido se resuelven antes por el callback NOSHOW.
const NO_CONTENT_TIMEOUT_MS = 10000;
// Si al vencer la ventana Flixmedia ya inyectó su wrapper (está renderizando pero
// los assets aún no llegan), se concede UNA prórroga antes de decidir.
const NO_CONTENT_GRACE_MS = 6000;
// Tope absoluto desde el init SOLO mientras loader.js no responde (ni onload ni
// onerror); al cargar el loader se cancela y manda la ventana de arriba.
const NO_CONTENT_HARD_CAP_MS = 15000;
// En modo embebido/multimedia no nos rendimos al primer timeout: se re-inyecta
// loader.js hasta MAX_ATTEMPTS veces antes de mostrar el fallback. Los timeouts
// reales en producción son casi todos "loader_ready_timeout" en redes lentas
// (≈4 % en Android), no productos sin contenido: esos llegan por NOSHOW.
const MAX_ATTEMPTS = 3;
const RETRY_DELAY_MS = 1500;

// Con conexión lenta (Network Information API, solo Chromium) las ventanas de
// espera se estiran; en el resto de navegadores el factor es 1.
function factorRedLenta(): number {
  if (typeof navigator === "undefined") return 1;
  const conn = (navigator as Navigator & { connection?: { effectiveType?: string; saveData?: boolean } }).connection;
  if (!conn) return 1;
  if (conn.effectiveType === "slow-2g" || conn.effectiveType === "2g") return 2.5;
  if (conn.effectiveType === "3g" || conn.saveData) return 1.6;
  return 1;
}

type FalloFlix = "noshow" | "timeout" | "error";


function FlixmediaPlayerComponent({
  mpn,
  ean,
  className = "",
  productId,
  segmento,
  preventRedirect = false,
  skipMatchApi = false,
  apiProduct,
  productColors
}: FlixmediaPlayerProps) {
  const router = useRouter();
  // Container ID ÚNICO por producto: evita que scripts de Flixmedia del producto anterior
  // (append.js, inpage.js con polling setTimeout) interfieran con el contenido nuevo.
  // Estos scripts buscan su container por ID y manipulan el DOM (resize, accordion, etc.).
  // Con un ID estático, los scripts viejos encuentran el container nuevo y lo corrompen.
  const containerId = `flix-inpage-${productId || 'default'}`;
  const [hasContent, setHasContent] = useState<boolean | null>(null);
  const [hasFlixError, setHasFlixError] = useState(false);
  // contentReady es INDEPENDIENTE de hasContent: en modo embebido/skipMatchApi
  // hasContent se pone true de inmediato (antes de que exista contenido visible),
  // así que el skeleton necesita su propia señal de "ya hay contenido real".
  // La alimentan: callback inpage, callback registrado, MutationObserver
  // (primer elemento real en el container) y la rama positiva del timeout de 4s.
  const [contentReady, setContentReady] = useState(false);
  const [skeletonGone, setSkeletonGone] = useState(false);
  // Intento actual (0 = primero). Cambiarlo re-ejecuta el effect completo.
  const [attempt, setAttempt] = useState(0);
  // Solo se fija cuando ya no habrá más reintentos: decide entre colapsar
  // (noshow: el producto no tiene contenido) y mostrar el fallback (timeout/error).
  const [failureKind, setFailureKind] = useState<FalloFlix | null>(null);

  // Crossfade de salida: al confirmar contenido, el skeleton se desvanece
  // (transition-opacity 300ms) y se desmonta después — nunca display:none en
  // seco, para enmascarar el swap de lazysizes sin flash de placeholders.
  useEffect(() => {
    if (!contentReady) return;
    const t = setTimeout(() => setSkeletonGone(true), 450);
    return () => clearTimeout(t);
  }, [contentReady]);

  // Refs para mantener valores actuales (evitar stale closures)
  // Router ref es CLAVE: useRouter() cambia de referencia en Next.js, lo que
  // causaba que redirectToView se recreara y el effect se re-ejecutara innecesariamente
  const routerRef = useRef(router);
  const segmentoRef = useRef(segmento);
  const productIdRef = useRef(productId);
  const apiProductRef = useRef(apiProduct);
  const productColorsRef = useRef(productColors);
  const preventRedirectRef = useRef(preventRedirect);
  const skipMatchApiRef = useRef(skipMatchApi);

  // Actualizar refs cuando cambien las props
  useEffect(() => {
    routerRef.current = router;
    segmentoRef.current = segmento;
    productIdRef.current = productId;
    apiProductRef.current = apiProduct;
    productColorsRef.current = productColors;
    preventRedirectRef.current = preventRedirect;
    skipMatchApiRef.current = skipMatchApi;
  }, [router, segmento, productId, apiProduct, productColors, preventRedirect, skipMatchApi]);

  const applyStyles = useCallback(() => {
    if (document.getElementById("flixmedia-player-styles")) return;
    const style = document.createElement("style");
    style.id = "flixmedia-player-styles";
    style.textContent = `
      [class*="flix_hotspot"], [id*="flix_hotspot"], div[class*="hotspot"] {
        display: none !important;
        visibility: hidden !important;
      }
      [id^="flix-inpage"] { width: 100%; min-height: 200px; }
      [id*="flix-inpage"] { width: 100%; min-height: 200px; }

      /* Ocultar errores de Flixmedia con fondo azul */
      [style*="background-color: rgb(23, 64, 122)"],
      [style*="background-color:#17407A"],
      [style*="background-color: #17407A"],
      [style*="background:#17407A"],
      [style*="background: #17407A"],
      div[style*="17407A"] {
        display: none !important;
        visibility: hidden !important;
        opacity: 0 !important;
        height: 0 !important;
        overflow: hidden !important;
      }
    `;
    document.head.appendChild(style);
  }, []);

  const hasPremiumContentCheck = useCallback((): boolean => {
    return checkPremiumContent(apiProductRef.current, productColorsRef.current);
  }, []);

  const redirectToView = useCallback(() => {
    if (preventRedirectRef.current) return;

    const currentSegmento = segmentoRef.current;
    const currentProductId = productIdRef.current;
    const isPremiumSegment = currentSegmento && (Array.isArray(currentSegmento) ? currentSegmento[0] : currentSegmento)?.toUpperCase() === 'PREMIUM';
    const hasPremium = hasPremiumContentCheck();

    const route = (isPremiumSegment || hasPremium)
      ? `/productos/viewpremium/${currentProductId}`
      : `/productos/view/${currentProductId}`;

    routerRef.current.replace(route);
  }, [hasPremiumContentCheck]);

  useEffect(() => {
    // Reset estado para nueva inicialización (evita stale state de producto anterior en SPA nav)
    setHasContent(null);
    setHasFlixError(false);
    setContentReady(false);
    setSkeletonGone(false);
    setFailureKind(null);
    const lentitud = factorRedLenta();
    let retryTimeoutId: ReturnType<typeof setTimeout> | null = null;

    // Durante SPA navigation, mpn pasa brevemente por null mientras selectedProductData
    // se resetea y useProduct carga datos frescos. NO inicializar en este estado transitorio:
    // - Evita redirect accidental a view (init() llama redirectToView cuando no hay MPN)
    // - Evita limpiar globals de Flixmedia innecesariamente
    // El effect se re-ejecutará cuando mpn reciba el valor correcto del nuevo producto.
    if (!mpn && !ean) {
      console.log('[FLIX] Effect: mpn y ean son null → esperando datos del producto');
      return;
    }

    let isMounted = true;
    const abortController = new AbortController();
    let observer: MutationObserver | null = null;
    let initTimeoutId: ReturnType<typeof setTimeout> | null = null;
    let cartClickGuardId: ReturnType<typeof setInterval> | null = null;
    let noContentTimeoutId: ReturnType<typeof setTimeout> | null = null;
    let hardCapTimeoutId: ReturnType<typeof setTimeout> | null = null;

    // Limpiar scripts y callbacks de Flixmedia para inicialización limpia.
    // IMPORTANTE: Solo se llama al INICIO de una nueva inicialización (dentro del setTimeout),
    // NUNCA en el cleanup del effect (StrictMode cancelaría el timeout del mount 1).
    //
    // NO borrar FlixjQ/FlixjQ2/FlixServices: los scripts del producto anterior (append.js,
    // inpage.js) tienen polling con setTimeout recursivo que NO se puede cancelar. Si borramos
    // estos globals, cada ciclo de setTimeout produce "FlixjQ is not defined" y corrompe el
    // estado del nuevo loader.js. Dejándolos, los scripts viejos usan el FlixjQ existente
    // sin errores, y el nuevo loader.js lo sobrescribe con su versión fresca.
    const cleanupFlixmedia = () => {
      // Remover scripts y iframes de Flixmedia del DOM (detiene nuevas cargas pero no setTimeouts internos)
      document.querySelectorAll('script[data-flix-distributor]').forEach(s => s.remove());
      document.querySelectorAll('script[src*="flixfacts.com"], script[src*="flixcar.com"]').forEach(s => s.remove());
      document.querySelectorAll('iframe[src*="flixcar.com"], iframe[src*="flixfacts.com"]').forEach(el => el.remove());
      // NO borrar window.flixJsCallbacks: los scripts de Flixmedia del producto
      // anterior (inpage.js con polling) acceden a window.flixJsCallbacks._loadInpageCallback
      // y con el objeto borrado lanzan "flixJsCallbacks is undefined" (visto en
      // PostHog). init() lo reemplaza por el objeto nuevo justo antes de cargar
      // loader.js; los handlers viejos ya están neutralizados por su isMounted=false.
    };

    const initStartTime = performance.now();

    // Telemetría (PostHog): UN resultado por inicialización, el primero que ocurra.
    // Sin esto era imposible saber desde producción por qué la página multimedia
    // "no muestra" contenido: console.log se elimina en el build y el replay
    // solo guarda warnings.
    let outcomeReported = false;
    // MPN realmente usado por loader.js (puede diferir de `mpn` si hubo candidatos)
    let resolvedMpn: string | null = null;
    const reportOutcome = (outcome: string, extra: Record<string, unknown> = {}) => {
      if (outcomeReported) return;
      outcomeReported = true;
      const positive = outcome === "inpage_callback" || outcome === "content_detected";
      posthogUtils.capture("flixmedia_result", {
        outcome,
        product_id: productIdRef.current || null,
        mpn: resolvedMpn || mpn || null,
        mpn_candidates: mpn || null,
        ean: ean || null,
        elapsed_ms: Math.round(performance.now() - initStartTime),
        mode: skipMatchApiRef.current ? "multimedia" : (preventRedirectRef.current ? "embedded" : "match"),
        redirects: !positive && !preventRedirectRef.current,
        ...extra,
      });
    };
    // Embebido (view/viewpremium) y multimedia reintentan antes de rendirse.
    // Agotados los intentos: multimedia sale a view (comportamiento acordado);
    // embebido, que ya está en view, muestra el fallback. Modo match: como antes.
    const puedeReintentar = () =>
      (preventRedirectRef.current || skipMatchApiRef.current) && attempt < MAX_ATTEMPTS - 1;
    const fallar = (kind: "timeout" | "error") => {
      setHasContent(false);
      setHasFlixError(true);
      if (puedeReintentar()) {
        retryTimeoutId = setTimeout(() => {
          if (isMounted) setAttempt((a) => a + 1);
        }, RETRY_DELAY_MS);
        return;
      }
      if (!preventRedirectRef.current) {
        redirectToView();
        return;
      }
      setFailureKind(kind);
    };

    const init = async () => {
      let targetMpn: string | null = null;
      let targetEan: string | null = null;

      const mpnCandidates = mpn ? parseSkuString(mpn) : [];
      // Un MPN con "/" también se prueba por su base (Flixmedia a veces solo conoce esa)
      for (const c of [...mpnCandidates]) {
        if (c.includes('/')) {
          const base = c.split('/')[0];
          if (base && !mpnCandidates.includes(base)) mpnCandidates.push(base);
        }
      }
      if (mpnCandidates.length > 0) targetMpn = mpnCandidates[0];
      if (!targetMpn && ean) {
        const eans = parseSkuString(ean);
        if (eans.length > 0) targetEan = eans[0];
      }

      console.log('[FLIX] Init (+0ms) SKU:', { mpn, mpnCandidates, targetEan });

      if (!targetMpn && !targetEan) {
        reportOutcome("no_mpn");
        if (!preventRedirectRef.current) {
          redirectToView();
        } else {
          setHasContent(false);
        }
        return;
      }

      // Precargar loader.js MIENTRAS se verifica Match API (en paralelo)
      const preloadLink = document.createElement('link');
      preloadLink.rel = 'preload';
      preloadLink.as = 'script';
      preloadLink.href = '//media.flixfacts.com/js/loader.js';
      document.head.appendChild(preloadLink);
      // service.js (~700 KB) y la ficha t.json salen de media.flixcar.com; los beats de rt.flix360.com.
      // Abrir esas conexiones ya recorta el arranque en redes lentas.
      for (const origin of ["https://media.flixcar.com", "https://rt.flix360.com"]) {
        if (!document.querySelector(`link[rel="preconnect"][href="${origin}"]`)) {
          const pre = document.createElement("link");
          pre.rel = "preconnect";
          pre.href = origin;
          pre.crossOrigin = "anonymous";
          document.head.appendChild(pre);
        }
      }

      // Los candidatos ya vienen ordenados por probabilidad (flixmediaCandidatesForVariant),
      // así que la página multimedia (skipMatchApi) carga loader.js DIRECTO con el
      // primero: cero latencia extra. En modo embebido (view/viewpremium, bajo el
      // pliegue) con varios candidatos se consulta el Match API (cacheado 24h) con un
      // tope corto para afinar la elección sin retrasar la carga.
      let matched = false;
      if (skipMatchApiRef.current) {
        setHasContent(true);
      } else if (preventRedirectRef.current) {
        if (mpnCandidates.length > 1) {
          try {
            const resolved = await resolveFlixmediaMpn(mpnCandidates, abortController.signal, 700);
            if (!isMounted) return;
            targetMpn = resolved.mpn;
            matched = resolved.matched;
            console.log('[FLIX] MPN resuelto entre candidatos:', { candidates: mpnCandidates, targetMpn, matched, timedOut: resolved.timedOut });
          } catch (error) {
            if (abortController.signal.aborted || !isMounted) return;
            console.log('[FLIX] Error resolviendo candidatos → usando el primero', error);
          }
        }
        setHasContent(true);
      } else {
        // Modo match (redirige si no hay contenido): verificar TODOS los candidatos
        // con el Match API, como antes se hacía con uno solo.
        try {
          if (targetMpn) {
            console.log('[FLIX] Verificando Match API para:', mpnCandidates);
            const resolved = await resolveFlixmediaMpn(mpnCandidates, abortController.signal);
            if (!isMounted) return;
            targetMpn = resolved.mpn;

            if (resolved.matched) {
              matched = true;
              setHasContent(true);
            }
          } else if (targetEan) {
            const result = await checkFlixmediaAvailabilityByEan(
              targetEan, undefined, undefined, abortController.signal
            );
            if (!isMounted) return;

            if (result.available) {
              matched = true;
              setHasContent(true);
            }
          }

          if (!matched) {
            // No confiar en el negativo del Match API: algunos MPNs (ej: con '/')
            // no son reconocidos por Match API pero sí por loader.js/service.js.
            // Seguir con loader.js como verificación definitiva.
            // El callback NOSHOW o el timeout de 4s manejarán el redirect si realmente no hay contenido.
            console.log('[FLIX] Match API: sin match → verificando con loader.js');
          }
        } catch (error) {
          if (abortController.signal.aborted || !isMounted) return;
          console.log('[FLIX] Error de red en Match API → fallback con loader.js', error);
          // noshow callback manejará la detección de "sin contenido"
        }
      }

      resolvedMpn = targetMpn;

      // Limpiar estado de Flixmedia antes de cargar nuevo contenido
      cleanupFlixmedia();
      if (!isMounted) return;

      const container = document.getElementById(containerId);
      if (!container) return;
      container.innerHTML = '';

      // Configurar callbacks de Flixmedia ANTES de cargar el script
      // Según la guía de integración, Flixmedia llama setLoadCallback(type) para notificar:
      // - 'inpage': contenido cargado exitosamente
      // - 'noshow': no hay contenido disponible (reemplaza el timeout de 2s)
      // También soporta setLoadCallback(fn, type) como API de registro
      window.flixJsCallbacks = {
        setLoadCallback: (typeOrFn: unknown, type?: string) => {
          const callbackType = typeof typeOrFn === 'string' ? typeOrFn : type;
          const fn = typeof typeOrFn === 'function' ? typeOrFn : null;

          if (callbackType === 'inpage') {
            console.log(`[FLIX] Callback INPAGE: contenido listo (+${Math.round(performance.now() - initStartTime)}ms)`);
            applyStyles();
            if (isMounted) {
              reportOutcome("inpage_callback");
              setHasContent(true);
              setContentReady(true);
            }
          } else if (callbackType === 'noshow') {
            console.log(`[FLIX] Callback NOSHOW: sin contenido (+${Math.round(performance.now() - initStartTime)}ms)`);
            if (!isMounted) return;
            reportOutcome("noshow_callback", { attempt });
            observer?.disconnect();
            setHasContent(false);
            setHasFlixError(true);
            setFailureKind("noshow");
            if (!preventRedirectRef.current) redirectToView();
          }

          if (fn) fn();
        },
        loadService: () => {}
      };

      // Callback del botón de carrito de Flixmedia. Su pagedata-specific.js
      // invoca window.flixJsCallbacks.flixCartClick() durante el render; si para
      // entonces Flixmedia ya reemplazó nuestro objeto de callbacks con el suyo
      // (lo hace al cargar loader.js), la función se pierde y su domTest lanza
      // "flixCartClick is not a function", abortando el render → contenido en
      // blanco INTERMITENTE (depende del timing/carga del hilo principal).
      // ensureFlixCartClick la reasigna sobre el objeto vigente; el guard corto
      // de abajo cubre la ventana de la carrera pase lo que pase.
      const flixCartClickHandler = () => {
        const currentSegmento = segmentoRef.current;
        const currentProductId = productIdRef.current;
        const isPremiumSegment = currentSegmento && (Array.isArray(currentSegmento) ? currentSegmento[0] : currentSegmento)?.toUpperCase() === 'PREMIUM';
        const hasPremium = hasPremiumContentCheck();
        const route = (isPremiumSegment || hasPremium)
          ? `/productos/viewpremium/${currentProductId}`
          : `/productos/view/${currentProductId}`;
        routerRef.current.push(route);
      };
      const ensureFlixCartClick = () => {
        const cb = window.flixJsCallbacks;
        if (cb && typeof cb.flixCartClick !== 'function') {
          cb.flixCartClick = flixCartClickHandler;
        }
      };
      ensureFlixCartClick();

      // Verificar si hay error de Flixmedia (fondo azul, texto de error)
      const checkForFlixError = () => {
        const cont = document.getElementById(containerId);
        if (!cont) return false;
        const text = cont.textContent?.toLowerCase() || '';
        const hasErrorText = text.includes('producto no encontrado') ||
                            text.includes('no se pudo cargar') ||
                            text.includes('product not found') ||
                            text.includes('no content available');
        const hasBlueBackground = cont.innerHTML.includes('17407A') ||
                                 cont.innerHTML.includes('rgb(23, 64, 122)');
        return hasErrorText || hasBlueBackground;
      };

      // Verificar si loader.js renderizó contenido multimedia real
      const hasRealContent = (cont: HTMLElement): boolean => {
        if (cont.children.length === 0) return false;
        return cont.querySelector('iframe') !== null ||
               cont.querySelectorAll('img').length > 1 ||
               cont.querySelector('video') !== null ||
               cont.querySelector('[class*="flix-"]') !== null;
      };

      // MutationObserver: detección de errores visuales (fondo azul) + primera
      // aparición de contenido real (dispara el crossfade del skeleton)
      observer = new MutationObserver(() => {
        if (!isMounted) { observer?.disconnect(); return; }
        const cont = document.getElementById(containerId);
        if (cont && hasRealContent(cont)) {
          reportOutcome("content_detected", { detected_by: "mutation" });
          setContentReady(true);
        }
        if (checkForFlixError()) {
          console.log('[FLIX] Error visual de Flixmedia detectado → redirigiendo');
          reportOutcome("visual_error", { attempt, will_retry: puedeReintentar() });
          observer?.disconnect();
          fallar("error");
        }
      });
      observer.observe(container, { childList: true, subtree: true, attributes: true });

      // Verificación de "sin contenido": cubre el caso donde ni inpage ni noshow
      // se disparan. Se programa (a) NO_CONTENT_TIMEOUT_MS después de que loader.js
      // esté listo y (b) como tope absoluto NO_CONTENT_HARD_CAP_MS desde el init.
      let graceUsed = false;
      const verifyNoContent = (reason: string) => {
        if (!isMounted || outcomeReported) return;
        const cont = document.getElementById(containerId);
        if (!cont) return;

        // Flixmedia ya montó su wrapper (encontró el producto) pero el contenido
        // real (imágenes/video) sigue en vuelo: una prórroga en vez de expulsar.
        if (!graceUsed && !checkForFlixError() && !hasRealContent(cont) && cont.querySelector('[id^="flixinpage_"]')) {
          graceUsed = true;
          console.log(`[FLIX] Wrapper presente sin contenido real (${reason}) → prórroga ${NO_CONTENT_GRACE_MS}ms`);
          noContentTimeoutId = setTimeout(() => verifyNoContent(`${reason}+grace`), NO_CONTENT_GRACE_MS * lentitud);
          return;
        }

        if (checkForFlixError() || !hasRealContent(cont)) {
          console.log(`[FLIX] Sin contenido real (${reason}) → redirigiendo`, {
            children: cont.children.length,
            innerHTML_length: cont.innerHTML.length,
            hasIframe: !!cont.querySelector('iframe'),
            hasImages: cont.querySelectorAll('img').length,
          });
          reportOutcome("timeout_no_content", {
            attempt,
            will_retry: puedeReintentar(),
            timeout_reason: reason,
            children: cont.children.length,
            inner_html_length: cont.innerHTML.length,
            has_iframe: !!cont.querySelector('iframe'),
            images: cont.querySelectorAll('img').length,
          });
          observer?.disconnect();
          fallar("timeout");
        } else {
          // Sí hay contenido real: asegurar que el skeleton se retire aunque
          // ningún callback ni mutación lo haya marcado (red de seguridad)
          reportOutcome("content_detected", { detected_by: reason });
          setContentReady(true);
        }
      };
      hardCapTimeoutId = setTimeout(() => verifyNoContent("hard_cap"), NO_CONTENT_HARD_CAP_MS * lentitud);

      // Cargar loader.js
      console.log(`[FLIX] Cargando loader.js MPN: ${targetMpn} (+${Math.round(performance.now() - initStartTime)}ms)`);
      const script = document.createElement("script");
      script.type = "text/javascript";
      script.async = true;
      script.setAttribute("data-flix-distributor", DISTRIBUTOR_ID);
      script.setAttribute("data-flix-language", LANGUAGE);
      script.setAttribute("data-flix-brand", "Samsung");
      script.setAttribute("data-flix-mpn", targetMpn || "");
      script.setAttribute("data-flix-ean", targetEan || "");
      script.setAttribute("data-flix-sku", "");
      script.setAttribute("data-flix-inpage", containerId);
      script.setAttribute("data-flix-button", "");
      script.setAttribute("data-flix-button-image", "");
      script.setAttribute("data-flix-price", "");
      script.setAttribute("data-flix-fallback-language", "");
      script.onload = () => {
        console.log(`[FLIX] loader.js listo (+${Math.round(performance.now() - initStartTime)}ms)`);
        applyStyles();

        // También intentar registrar callbacks con la API de Flixmedia (por si usa registro)
        // Esto es un safety net: si Flixmedia reemplazó flixJsCallbacks con su propia impl
        try {
          if (window.flixJsCallbacks && typeof window.flixJsCallbacks.setLoadCallback === 'function') {
            window.flixJsCallbacks.setLoadCallback(() => {
              console.log(`[FLIX] Registered INPAGE callback fired (+${Math.round(performance.now() - initStartTime)}ms)`);
              applyStyles();
              if (isMounted) {
                reportOutcome("inpage_callback");
                setHasContent(true);
                setContentReady(true);
              }
            }, 'inpage');
            window.flixJsCallbacks.setLoadCallback(() => {
              console.log(`[FLIX] Registered NOSHOW callback fired (+${Math.round(performance.now() - initStartTime)}ms)`);
              if (!isMounted) return;
              reportOutcome("noshow_callback", { attempt });
              observer?.disconnect();
              setHasContent(false);
              setHasFlixError(true);
              setFailureKind("noshow");
              if (!preventRedirectRef.current) redirectToView();
            }, 'noshow');
          }
        } catch { /* flixJsCallbacks may have been replaced */ }
        // Flixmedia ya cargó y pudo reemplazar el objeto de callbacks: reasignar
        // flixCartClick sobre el objeto vigente antes de que corra pagedata-specific.js
        ensureFlixCartClick();
        // La ventana de "sin contenido" empieza AQUÍ, con Flixmedia ya alcanzable;
        // el tope absoluto deja de aplicar (era solo para un loader que no responde).
        if (hardCapTimeoutId) { clearTimeout(hardCapTimeoutId); hardCapTimeoutId = null; }
        if (isMounted && !outcomeReported) {
          noContentTimeoutId = setTimeout(() => verifyNoContent("loader_ready_timeout"), NO_CONTENT_TIMEOUT_MS * lentitud);
        }
      };
      script.onerror = () => {
        console.log('[FLIX] Error cargando loader.js → redirigiendo');
        if (!isMounted) return;
        reportOutcome("loader_error", { attempt, will_retry: puedeReintentar() });
        fallar("error");
      };
      script.src = "//media.flixfacts.com/js/loader.js";
      document.head.appendChild(script);

      // Guard de la carrera: durante la carga de Flixmedia, garantizar que
      // flixCartClick siempre exista sobre el objeto de callbacks vigente, sin
      // importar cuándo Flixmedia lo reemplace. Cubre la ventana en que corre
      // su domTest (~primeros segundos). Se detiene solo a los 6s y en cleanup.
      cartClickGuardId = setInterval(ensureFlixCartClick, 120);
      setTimeout(() => {
        if (cartClickGuardId) { clearInterval(cartClickGuardId); cartClickGuardId = null; }
      }, 6000);

    };

    // Siempre limpiar y re-inicializar. No intentar "reutilizar" contenido existente:
    // - Los scripts de Flixmedia inyectan wrappers vacíos que pasan selectores DOM pero no tienen contenido visible
    // - Al navegar de vuelta al mismo producto, el container tiene elementos rotos de scripts viejos
    // - StrictMode solo corre en dev: el flash es cosmético, el bug de contenido roto es funcional
    // El setTimeout(0) sigue siendo necesario: en StrictMode, mount 1 encola el timeout,
    // cleanup lo cancela, mount 2 encola uno nuevo que sí ejecuta. Solo se ejecuta UNA init().
    initTimeoutId = setTimeout(() => {
      cleanupFlixmedia();
      init();
    }, 0);

    return () => {
      isMounted = false;
      if (initTimeoutId) clearTimeout(initTimeoutId);
      if (cartClickGuardId) clearInterval(cartClickGuardId);
      if (noContentTimeoutId) clearTimeout(noContentTimeoutId);
      if (hardCapTimeoutId) clearTimeout(hardCapTimeoutId);
      if (retryTimeoutId) clearTimeout(retryTimeoutId);
      abortController.abort();
      observer?.disconnect();
    };
  // Re-ejecutar cuando mpn o productId cambian.
  // NO incluir ean: cuando la API carga, ean pasa de null a un valor real para el MISMO producto,
  // lo que dispararía una segunda init que destruye el contenido ya cargado.
  // productId cubre cambios de producto. mpn cubre cambios de SKU dentro del mismo producto.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mpn, productId, attempt]);

  // Sin contenido: no renderizar nada (ni mensaje)
  if (!mpn && !ean) return null;
  // NOSHOW (producto sin contenido): se colapsa como siempre.
  if (failureKind === "noshow") return null;
  // Mientras hay un reintento en curso el contenedor sigue montado; el fallback
  // visible es solo para la vista embebida (multimedia redirige a view).
  const reintentando = hasFlixError && failureKind === null && (preventRedirect || skipMatchApi);
  const mostrarFallback = preventRedirect && (failureKind === "timeout" || failureKind === "error");
  if (!reintentando && !mostrarFallback && (hasContent === false || hasFlixError)) return null;
  const reintentar = () => {
    setFailureKind(null);
    setHasFlixError(false);
    setHasContent(null);
    setAttempt((a) => a + 1);
  };
  const fichaCompletaHref =
    !skipMatchApi && productId ? `/productos/multimedia/${String(productId).split("/")[0]}` : null;

  // Renderizar container - visible cuando hay contenido o aún cargando (null).
  // El skeleton va como OVERLAY absoluto sobre el container SIEMPRE montado:
  // el container es el target data-flix-inpage y desmontarlo/condicionarlo
  // rompe los scripts de Flixmedia que lo buscan por id.
  return (
    <div className={`${className} w-full min-h-[200px] relative`}>
      <div
        id={containerId}
        className="w-full"
      />
      {mostrarFallback && (
        <div className="mx-auto max-w-5xl px-4 py-10 text-center">
          <p className="text-base font-semibold text-gray-900">No pudimos cargar la ficha del producto</p>
          <p className="mt-1 text-sm text-gray-600">
            Parece que la conexión está lenta. Puedes intentarlo de nuevo{fichaCompletaHref ? " o abrir la ficha completa" : ""}.
          </p>
          <div className="mt-5 flex flex-wrap justify-center gap-3">
            <button
              type="button"
              onClick={reintentar}
              className="rounded-full bg-black px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-gray-800"
            >
              Reintentar
            </button>
            {fichaCompletaHref && (
              <Link
                href={fichaCompletaHref}
                className="rounded-full border border-gray-300 px-5 py-2.5 text-sm font-semibold text-gray-900 transition hover:bg-gray-50"
              >
                Ver ficha completa
              </Link>
            )}
          </div>
        </div>
      )}
      {!skeletonGone && !mostrarFallback && (
        <div
          aria-hidden="true"
          className={`absolute inset-0 z-[1] overflow-hidden pointer-events-none bg-white transition-opacity duration-300 ${contentReady ? "opacity-0" : "opacity-100"}`}
        >
          <div className="h-full w-full animate-pulse px-4 py-8">
            <div className="mx-auto max-w-5xl space-y-4">
              <div className="mx-auto h-7 w-2/3 rounded-lg bg-gray-200" />
              <div className="mx-auto h-4 w-1/2 rounded bg-gray-100" />
              <div className="mt-6 h-56 w-full rounded-2xl bg-gray-100" />
              <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
                <div className="h-20 rounded-xl bg-gray-100" />
                <div className="h-20 rounded-xl bg-gray-100" />
                <div className="h-20 rounded-xl bg-gray-100" />
                <div className="h-20 rounded-xl bg-gray-100" />
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

const FlixmediaPlayer = memo(FlixmediaPlayerComponent, (prevProps, nextProps) => {
  // Solo comparar mpn y productId (los deps del effect) + flags de comportamiento.
  // NO incluir ean: cambia de null→valor cuando la API carga, pero es el mismo producto.
  // Incluirlo causa re-render innecesario que puede interferir con Flixmedia.
  return prevProps.mpn === nextProps.mpn &&
         prevProps.productId === nextProps.productId &&
         prevProps.preventRedirect === nextProps.preventRedirect &&
         prevProps.skipMatchApi === nextProps.skipMatchApi;
});

FlixmediaPlayer.displayName = "FlixmediaPlayer";
export default FlixmediaPlayer;
