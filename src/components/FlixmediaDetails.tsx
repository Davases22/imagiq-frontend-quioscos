/**
 * FlixmediaDetails Component
 *
 * Carga especificaciones de Flixmedia INMEDIATAMENTE al montar.
 * Usa IDs dinámicos para evitar conflictos en el DOM durante navegación SPA.
 */

"use client";

import { useEffect, useRef, memo, useCallback, useState } from "react";
import { parseSkuString } from "@/lib/flixmedia";
import { FlixmediaSpecsSkeleton } from "./FlixmediaStates";

declare global {
  interface Window {
    flixJsCallbacks?: {
      // Dual API: Flixmedia llama con (type) para notificar, o se registra con (fn, type)
      setLoadCallback: (typeOrFn: unknown, type?: string) => void;
      loadService: (type: string) => void;
      // Registrado por FlixmediaPlayer para los botones "comprar" de Flixmedia.
      flixCartClick?: () => void;
    };
  }
}

interface FlixmediaDetailsProps {
  mpn?: string | null;
  ean?: string | null;
  productName?: string;
  className?: string;
  onError?: () => void;
}

/**
 * Hook personalizado para precargar Flixmedia temprano
 */
function useFlixmediaPreload() {
  useEffect(() => {
    // Precargar recursos de Flixmedia apenas se monte el componente
    if (typeof window === 'undefined') return;

    // DNS prefetch
    const dnsPrefetch = document.createElement('link');
    dnsPrefetch.rel = 'dns-prefetch';
    dnsPrefetch.href = '//media.flixfacts.com';
    if (!document.querySelector('link[href="//media.flixfacts.com"]')) {
      document.head.appendChild(dnsPrefetch);
    }

    // Preconnect
    const preconnect = document.createElement('link');
    preconnect.rel = 'preconnect';
    preconnect.href = 'https://media.flixfacts.com';
    preconnect.crossOrigin = 'anonymous';
    if (!document.querySelector('link[href="https://media.flixfacts.com"]')) {
      document.head.appendChild(preconnect);
    }

    // Preload del script
    const preload = document.createElement('link');
    preload.rel = 'preload';
    preload.as = 'script';
    preload.href = '//media.flixfacts.com/js/loader.js';
    if (!document.querySelector('link[href="//media.flixfacts.com/js/loader.js"]')) {
      document.head.appendChild(preload);
    }
  }, []);
}

function FlixmediaDetailsComponent({
  mpn,
  ean,
  className = "",
  onError,
}: FlixmediaDetailsProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  // Generar ID único para este montaje - usar timestamp para garantizar unicidad en navegación SPA
  const [uniqueId] = useState(() => `flix-specifications-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`);
  const currentMpnRef = useRef<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  // Estado para ocultar si Flixmedia muestra error
  const [hasFlixError, setHasFlixError] = useState(false);

  // Precargar recursos de Flixmedia temprano
  useFlixmediaPreload();

  const applyStyles = useCallback(() => {
    if (document.getElementById('flixmedia-specifications-styles')) return;

    const style = document.createElement('style');
    style.id = 'flixmedia-specifications-styles';
    style.textContent = `
      /* Ocultar mensajes de error de Flixmedia */
      [id^="flix-"] .flix-error,
      [id^="flix-"] .flix-no-content,
      [id^="flix-"] [class*="error"],
      [id^="flix-"] [class*="not-found"],
      [id^="flix-inpage"] > div[style*="background"],
      .flix-std-content-not-found,
      .flix-content-not-found,
      [class*="flix"][class*="error"],
      [class*="flix"][class*="not-found"] {
        display: none !important;
        visibility: hidden !important;
        height: 0 !important;
        overflow: hidden !important;
      }
      [id^="flix-specifications-"] [flixtemplate-key="footnotes"],
      [id^="flix-specifications-"] [flixtemplate-key="image_gallery"],
      [class*="flix_hotspot"], [id*="flix_hotspot"], div[class*="hotspot"] {
        display: none !important;
        visibility: hidden !important;
      }
      [id^="flix-specifications-"] [flixtemplate-key="features"] > *:not(.inpage_selector_keyfeature) {
        display: none !important;
      }
      [id^="flix-specifications-"] [flixtemplate-key="specifications"],
      [id^="flix-specifications-"] [flixtemplate-key="features"],
      [id^="flix-specifications-"] .inpage_selector_keyfeature {
        display: block !important;
        visibility: visible !important;
      }
      [id^="flix-specifications-"] { width: 100%; background: transparent; }
      [id^="flix-specifications-"] [flixtemplate-key="specifications"] {
        background-color: transparent !important;
        padding: 0 !important;
      }
      [id^="flix-specifications-"] [flixtemplate-key="specifications"] h2,
      [id^="flix-specifications-"] [flixtemplate-key="specifications"] h3 {
        display: none !important;
      }
      [id^="flix-specifications-"] .inpage_spec-list {
        margin-bottom: 0 !important;
        border: none !important;
        padding: 0 !important;
      }
      [id^="flix-specifications-"] .inpage_spec-header {
        display: flex !important;
        flex-direction: column !important;
        gap: 12px !important;
        padding: 16px 8px !important;
      }
      @media (min-width: 640px) {
        [id^="flix-specifications-"] .inpage_spec-header {
          flex-direction: row !important;
          justify-content: space-between !important;
          align-items: center !important;
          padding: 20px 16px !important;
        }
      }
      [id^="flix-specifications-"] .inpage_spec-header h2,
      [id^="flix-specifications-"] .inpage_spec-header .inpage_spec-title {
        font-size: 20px !important;
        line-height: 1.3 !important;
        margin: 0 !important;
        text-align: center !important;
      }
      @media (min-width: 640px) {
        [id^="flix-specifications-"] .inpage_spec-header h2,
        [id^="flix-specifications-"] .inpage_spec-header .inpage_spec-title {
          font-size: 24px !important;
          text-align: left !important;
        }
      }
      @media (min-width: 768px) {
        [id^="flix-specifications-"] .inpage_spec-header h2,
        [id^="flix-specifications-"] .inpage_spec-header .inpage_spec-title {
          font-size: 28px !important;
        }
      }
      [id^="flix-specifications-"] .inpage_spec-header button,
      [id^="flix-specifications-"] .inpage_spec-header .inpage_spec-expand-btn {
        font-size: 13px !important;
        padding: 8px 16px !important;
        white-space: nowrap !important;
        width: 100% !important;
        max-width: 200px !important;
        margin: 0 auto !important;
      }
      @media (min-width: 640px) {
        [id^="flix-specifications-"] .inpage_spec-header button,
        [id^="flix-specifications-"] .inpage_spec-header .inpage_spec-expand-btn {
          font-size: 14px !important;
          padding: 10px 20px !important;
          width: auto !important;
          margin: 0 !important;
        }
      }
      [id^="flix-specifications-"] .inpage_spec-content {
        padding: 8px !important;
        overflow: hidden !important;
      }
      [id^="flix-specifications-"] .inpage_spec-content table { width: 100% !important; }
      [id^="flix-specifications-"] .inpage_spec-list { gap: 12px !important; }
      [id^="flix-specifications-"] .inpage_spec-row {
        display: grid !important;
        grid-template-columns: minmax(0, 180px) 1fr !important;
        gap: 8px !important;
        padding: 12px 0 !important;
        border-bottom: 1px solid #f0f2f7 !important;
      }
      [id^="flix-specifications-"] .inpage_spec-row:last-child { border-bottom: none !important; }
      [id^="flix-specifications-"] .inpage_spec-attribute,
      [id^="flix-specifications-"] .inpage_spec-value {
        font-size: 14px !important;
        line-height: 1.4 !important;
        color: #0a1124 !important;
      }
      [id^="flix-specifications-"] .inpage_spec-attribute { font-weight: 600 !important; }
      [id^="flix-specifications-"] .inpage_selector_keyfeature {
        display: grid !important;
        grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)) !important;
        gap: 12px !important;
        list-style: none !important;
        padding: 0 !important;
        margin: 0 0 24px !important;
      }
      [id^="flix-specifications-"] .inpage_selector_keyfeature li,
      [id^="flix-specifications-"] .inpage_selector_keyfeature .inpage_keyfeature-item {
        display: flex !important;
        flex-direction: column !important;
        justify-content: center !important;
        align-items: center !important;
        gap: 8px !important;
        padding: 16px 12px !important;
        background: #fff !important;
        border-radius: 16px !important;
        border: 1px solid #e2e6f0 !important;
        min-height: 120px !important;
        text-align: center !important;
        box-shadow: 0 1px 2px rgba(15, 23, 42, 0.07) !important;
      }
      [id^="flix-specifications-"] .inpage_selector_keyfeature img,
      [id^="flix-specifications-"] .inpage_selector_keyfeature svg {
        max-width: 48px !important;
        width: 48px !important;
        height: auto !important;
        object-fit: contain !important;
      }
      [id^="flix-specifications-"] .inpage_selector_keyfeature p,
      [id^="flix-specifications-"] .inpage_selector_keyfeature span {
        font-size: 13px !important;
        line-height: 1.35 !important;
        color: #0a1124 !important;
      }
      @media (min-width: 640px) {
        [id^="flix-specifications-"] .inpage_spec-content { padding: 16px !important; }
      }
      @media (max-width: 768px) {
        [id^="flix-specifications-"] .inpage_spec-row {
          grid-template-columns: 1fr !important;
          padding: 10px 0 !important;
        }
      }
      @media (max-width: 640px) {
        [id^="flix-specifications-"] .inpage_selector_keyfeature {
          grid-template-columns: repeat(2, minmax(0, 1fr)) !important;
        }
      }
      @media (max-width: 480px) {
        [id^="flix-specifications-"] .inpage_selector_keyfeature { grid-template-columns: 1fr !important; }
        [id^="flix-specifications-"] .inpage_spec-header h2,
        [id^="flix-specifications-"] .inpage_spec-header .inpage_spec-title {
          font-size: 18px !important;
        }
      }
    `;
    document.head.appendChild(style);
  }, []);

  useEffect(() => {
    // Cargar inmediatamente al montar el componente
    let isMounted = true;
    let targetMpn: string | null = null;
    let targetEan: string | null = null;

    if (mpn) {
      const skus = parseSkuString(mpn);
      if (skus.length > 0) targetMpn = skus[0];
    }
    if (!targetMpn && ean) {
      const eans = parseSkuString(ean);
      if (eans.length > 0) targetEan = eans[0];
    }
    if (!targetMpn && !targetEan) {
      setIsLoading(false);
      return;
    }

    const productKey = targetMpn || targetEan || '';

    // Limpiar scripts y contenedores de Flixmedia previos
    const cleanupFlixmediaScripts = () => {
      const allFlixScripts = document.querySelectorAll('script[data-flix-inpage], script[src*="flixfacts"], script[src*="flixcar"]');
      allFlixScripts.forEach(s => s.remove());

      const allFlixContainers = document.querySelectorAll('[id^="flix-specifications-"]');
      allFlixContainers.forEach(container => {
        if (container.id !== uniqueId) {
          container.innerHTML = '';
        }
      });

      if (typeof window !== 'undefined') {
        (window as typeof window & { flixLoaded?: unknown }).flixLoaded = undefined;
        (window as typeof window & { _flix?: unknown })._flix = undefined;
        (window as typeof window & { flix?: unknown }).flix = undefined;
        (window as typeof window & { FlixMedia?: unknown }).FlixMedia = undefined;
      }
    };

    // Limpiar scripts previos
    cleanupFlixmediaScripts();
    currentMpnRef.current = productKey;

    // Función para verificar si el contenedor está listo
    const waitForContainer = (): Promise<HTMLElement> => {
      return new Promise((resolve, reject) => {
        let attempts = 0;
        const maxAttempts = 50;

        const checkContainer = () => {
          attempts++;
          const container = document.getElementById(uniqueId);

          if (container) {
            resolve(container);
          } else if (attempts >= maxAttempts) {
            reject(new Error('Container timeout'));
          } else {
            setTimeout(checkContainer, 100);
          }
        };

        checkContainer();
      });
    };

    const loadScript = (container: HTMLElement) => {
      container.innerHTML = '';

      const oldScripts = document.querySelectorAll(`script[data-flix-inpage="${uniqueId}"]`);
      oldScripts.forEach(s => s.remove());

      const checkForFlixError = () => {
        const cont = document.getElementById(uniqueId);
        if (!cont) return false;

        const text = cont.textContent?.toLowerCase() || '';
        const hasErrorText = text.includes('producto no encontrado') ||
                        text.includes('no se pudo cargar') ||
                        text.includes('product not found') ||
                        text.includes('no content available') ||
                        text.includes('información del producto');

        const hasBlueBackground = cont.innerHTML.includes('17407A') ||
                                 cont.innerHTML.includes('rgb(23, 64, 122)');

        const hasValidContent = cont.querySelector('.inpage_spec-list, .inpage_selector_keyfeature, [flixtemplate-key="specifications"], [flixtemplate-key="features"]');

        return hasErrorText || hasBlueBackground || (!hasValidContent && cont.children.length > 0);
      };

      // Configurar callbacks ANTES de cargar el script
      window.flixJsCallbacks = {
        setLoadCallback: (typeOrFn: unknown) => {
          const fn = typeof typeOrFn === 'function' ? typeOrFn : null;
          setTimeout(() => {
            if (fn) fn();
            applyStyles();
            if (isMounted) {
              setTimeout(() => {
                if (checkForFlixError()) {
                  setHasFlixError(true);
                  onError?.();
                }
                setIsLoading(false);
              }, 500);
            }
          }, 100);
        },
        loadService: () => {}
      };

      // MutationObserver para detectar errores
      const observer = new MutationObserver(() => {
        const cont = document.getElementById(uniqueId);
        if (!cont) return;

        const text = cont.textContent?.toLowerCase() || '';
        if (text.includes('producto no encontrado') ||
            text.includes('no se pudo cargar') ||
            text.includes('información del producto')) {
          observer.disconnect();
          setHasFlixError(true);
          onError?.();
        }
      });
      observer.observe(container, { childList: true, subtree: true, characterData: true });

      // Crear y configurar el script
      const headID = document.getElementsByTagName("head")[0];
      const flixScript = document.createElement('script');
      flixScript.type = 'text/javascript';
      flixScript.async = true;

      // Configurar atributos según PDF Sección 1b
      flixScript.setAttribute('data-flix-distributor', '17257');
      flixScript.setAttribute('data-flix-language', 'f5');
      flixScript.setAttribute('data-flix-brand', 'Samsung');
      flixScript.setAttribute('data-flix-mpn', targetMpn || '');
      flixScript.setAttribute('data-flix-ean', targetEan || '');
      flixScript.setAttribute('data-flix-inpage', uniqueId);
      flixScript.setAttribute('data-flix-button', '');
      flixScript.setAttribute('data-flix-price', '');
      flixScript.setAttribute('data-flix-hotspot', 'false');

      flixScript.onload = function () {
        applyStyles();
      };

      flixScript.onerror = function () {
        console.error('[FLIXMEDIA DETAILS] Error cargando script loader.js');
        if (isMounted) {
          setIsLoading(false);
        }
      };

      // Timeout fallback
      setTimeout(() => {
        if (isMounted) {
          if (checkForFlixError()) {
            setHasFlixError(true);
            onError?.();
          }
          setIsLoading(false);
        }
      }, 5000);

      headID.appendChild(flixScript);
      flixScript.src = '//media.flixfacts.com/js/loader.js';
    };

    waitForContainer()
      .then(loadScript)
      .catch(err => {
        console.error('[FLIXMEDIA DETAILS] Error:', err);
        if (isMounted) setIsLoading(false);
      });

    return () => {
      isMounted = false;
      // Limpiar scripts específicos de este componente
      const scripts = document.querySelectorAll(`script[data-flix-inpage="${uniqueId}"]`);
      scripts.forEach(s => s.remove());
      // Limpiar el contenedor
      const container = document.getElementById(uniqueId);
      if (container) {
        container.innerHTML = '';
      }
      currentMpnRef.current = null;
    };
  }, [mpn, ean, applyStyles, uniqueId, onError]);

  if (!mpn && !ean) {
    return null;
  }

  // Si Flixmedia mostró un error, no renderizar nada
  if (hasFlixError) {
    return null;
  }

  return (
    <div ref={containerRef} className={`${className} w-full relative min-h-[100px]`}>
      {/* Mostrar skeleton mientras carga */}
      {isLoading && (
        <div className="absolute inset-0 z-10 bg-white">
          <FlixmediaSpecsSkeleton />
        </div>
      )}
      <div
        id={uniqueId}
        className="w-full"
        style={{ opacity: isLoading ? 0 : 1, transition: 'opacity 0.2s ease-in' }}
      />
    </div>
  );
}

const FlixmediaDetails = memo(FlixmediaDetailsComponent, (prevProps, nextProps) => {
  return prevProps.mpn === nextProps.mpn && prevProps.ean === nextProps.ean;
});

FlixmediaDetails.displayName = 'FlixmediaDetails';
export default FlixmediaDetails;
