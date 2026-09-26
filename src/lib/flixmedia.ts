/**
 * Utilidades para la integración con Flixmedia
 * Funciones para verificar disponibilidad de contenido multimedia
 */

const FLIXMEDIA_CONFIG = {
  distributorId: "17257",
  language: "f5",
  matchApiUrl: "https://media.flixcar.com/delivery/webcall/match",
  contentUrl: "https://media.flixcar.com/delivery/webcall/content",
} as const;

export interface FlixmediaAvailability {
  available: boolean;
  productId?: string;
}

// Cache del Match API en dos niveles:
// 1. In-memory (Map): lecturas instantáneas dentro de la misma pestaña
// 2. localStorage: sobrevive refresh/nuevas pestañas. Positivos 24h (que un
//    MPN tenga contenido casi nunca cambia); negativos 1h (Flixmedia puede
//    publicar contenido nuevo).
const matchCache = new Map<string, { result: FlixmediaAvailability; timestamp: number }>();
const POSITIVE_TTL = 24 * 60 * 60 * 1000;
const NEGATIVE_TTL = 60 * 60 * 1000;
const PERSIST_KEY = "flixmedia_match_cache_v1";

type PersistedMatchCache = Record<string, { result: FlixmediaAvailability; timestamp: number }>;

function ttlFor(result: FlixmediaAvailability): number {
  return result.available ? POSITIVE_TTL : NEGATIVE_TTL;
}

function readPersistedCache(): PersistedMatchCache {
  if (typeof window === "undefined") return {};
  try {
    return JSON.parse(window.localStorage.getItem(PERSIST_KEY) || "{}");
  } catch {
    return {};
  }
}

function getCachedMatch(cacheKey: string): FlixmediaAvailability | null {
  const cached = matchCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < ttlFor(cached.result)) {
    return cached.result;
  }
  if (cached) matchCache.delete(cacheKey);

  const persisted = readPersistedCache()[cacheKey];
  if (persisted && Date.now() - persisted.timestamp < ttlFor(persisted.result)) {
    // Hidratar el nivel in-memory para las siguientes lecturas
    matchCache.set(cacheKey, persisted);
    return persisted.result;
  }
  return null;
}

function setCachedMatch(cacheKey: string, result: FlixmediaAvailability): void {
  const entry = { result, timestamp: Date.now() };
  matchCache.set(cacheKey, entry);

  if (typeof window === "undefined") return;
  try {
    const persisted = readPersistedCache();
    // Podar entradas expiradas para que el objeto no crezca sin límite
    for (const [key, value] of Object.entries(persisted)) {
      if (Date.now() - value.timestamp >= ttlFor(value.result)) {
        delete persisted[key];
      }
    }
    persisted[cacheKey] = entry;
    window.localStorage.setItem(PERSIST_KEY, JSON.stringify(persisted));
  } catch {
    // localStorage lleno o bloqueado: el nivel in-memory sigue funcionando
  }
}

/**
 * Resuelve el match contra el proxy propio (/api/flixmedia/match), que cachea
 * server-side con el Data Cache de Next y se comparte entre TODOS los usuarios.
 * Si el proxy falla (red, 5xx), cae al Match API directo de Flixmedia.
 */
async function fetchMatch(
  kind: "mpn" | "ean",
  value: string,
  distributorId: string,
  language: string,
  signal?: AbortSignal
): Promise<FlixmediaAvailability> {
  try {
    const params = new URLSearchParams({ kind, value, distributor: distributorId, language });
    const response = await fetch(`/api/flixmedia/match?${params.toString()}`, signal ? { signal } : undefined);
    if (response.ok) {
      const data = await response.json();
      return data.available && data.productId
        ? { available: true, productId: data.productId }
        : { available: false };
    }
  } catch (error) {
    // Abort del caller: propagar para no cachear un falso negativo
    if (error instanceof DOMException && error.name === "AbortError") throw error;
  }

  // Fallback: Match API directo (comportamiento original)
  const url = `${FLIXMEDIA_CONFIG.matchApiUrl}/${distributorId}/${language}/${kind}/${encodeURIComponent(value)}`;
  const response = await fetch(url, signal ? { signal } : undefined);
  const data = await response.json();
  return data.event === "matchhit" && data.product_id
    ? { available: true, productId: data.product_id }
    : { available: false };
}

/**
 * Verifica si Flixmedia tiene contenido para un MPN/SKU específico
 */
export async function checkFlixmediaAvailability(
  mpn: string,
  distributorId: string = FLIXMEDIA_CONFIG.distributorId,
  language: string = FLIXMEDIA_CONFIG.language,
  signal?: AbortSignal
): Promise<FlixmediaAvailability> {
  const cacheKey = `mpn:${distributorId}:${language}:${mpn}`;
  const cached = getCachedMatch(cacheKey);
  if (cached) return cached;

  try {
    const result = await fetchMatch("mpn", mpn, distributorId, language, signal);
    setCachedMatch(cacheKey, result);
    return result;
  } catch {
    return { available: false };
  }
}

/**
 * Verifica si Flixmedia tiene contenido para un EAN/Barcode específico
 */
export async function checkFlixmediaAvailabilityByEan(
  ean: string,
  distributorId: string = FLIXMEDIA_CONFIG.distributorId,
  language: string = FLIXMEDIA_CONFIG.language,
  signal?: AbortSignal
): Promise<FlixmediaAvailability> {
  const cacheKey = `ean:${distributorId}:${language}:${ean}`;
  const cached = getCachedMatch(cacheKey);
  if (cached) return cached;

  try {
    const result = await fetchMatch("ean", ean, distributorId, language, signal);
    setCachedMatch(cacheKey, result);
    return result;
  } catch {
    return { available: false };
  }
}

/**
 * Busca el primer SKU disponible en una lista de SKUs
 * Usa Promise.any() para búsqueda paralela
 */
export async function findAvailableSku(skus: string[]): Promise<string | null> {
  try {
    const promises = skus.map(async (sku) => {
      const result = await checkFlixmediaAvailability(sku);
      if (result.available) {
        return sku;
      }
      throw new Error(`SKU ${sku} no disponible`);
    });

    const availableSku = await Promise.any(promises);
    return availableSku;
  } catch {
    return null;
  }
}

/**
 * Busca el primer EAN disponible en una lista de EANs
 * Usa Promise.any() para búsqueda paralela
 */
export async function findAvailableEan(eans: string[]): Promise<string | null> {
  try {
    const promises = eans.map(async (ean) => {
      const result = await checkFlixmediaAvailabilityByEan(ean);
      if (result.available) {
        return ean;
      }
      throw new Error(`EAN ${ean} no disponible`);
    });

    const availableEan = await Promise.any(promises);
    return availableEan;
  } catch {
    return null;
  }
}

/**
 * Construye la URL del iframe de Flixmedia
 */
export function buildFlixmediaUrl(
  mpn: string,
  distributorId: string = FLIXMEDIA_CONFIG.distributorId,
  language: string = FLIXMEDIA_CONFIG.language
): string {
  return `${FLIXMEDIA_CONFIG.contentUrl}/${distributorId}/${language}/mpn/${mpn}`;
}

/**
 * Genera variantes del MPN para probar con Flixmedia
 * Algunos productos usan formato con guiones/barras y otros sin ellos
 */
export function generateMpnVariants(mpn: string): string[] {
  const variants: string[] = [mpn];

  const normalized = mpn.replace(/[-\/\s]/g, '');
  if (normalized !== mpn) {
    variants.push(normalized);
  }

  const withSlash = mpn.replace(/-/g, '/');
  if (withSlash !== mpn && !variants.includes(withSlash)) {
    variants.push(withSlash);
  }

  const withDash = mpn.replace(/\//g, '-');
  if (withDash !== mpn && !variants.includes(withDash)) {
    variants.push(withDash);
  }

  return variants;
}

/**
 * Procesa una cadena de SKUs (separados por comas) y devuelve un array
 */
export function parseSkuString(skuString: string): string[] {
  return skuString
    .split(",")
    .map((sku) => sku.trim())
    .filter((sku) => sku.length > 0);
}

function cleanSku(v: string | null | undefined): string {
  const s = (v || "").trim();
  // Novasoft usa "0" como "sin padre"
  return s === "0" ? "" : s;
}

/**
 * Candidatos de MPN para Flixmedia de UNA variante, en orden de preferencia y
 * sin repetidos (el player los recibe unidos por coma).
 *
 * Regla (verificada contra el Match API el 10-sep-2026 sobre los 76 SKUs con
 * padre distinto): si Novasoft asignó un `skuflixmedia` propio (≠ sku) se
 * respeta; si `skuflixmedia` es simplemente el sku y existe un SKU padre
 * (`descGeneral`), el padre va PRIMERO. Los únicos casos reales son los bundles
 * "F-QN55LS03HEKB" (The Frame + marco): Flixmedia solo conoce el padre
 * "QN55LS03HEKXZL". Cuando Novasoft retiró los SKUs individuales, el player
 * quedó con el F- y Flixmedia respondía NOSHOW. Con el padre primero, la
 * página multimedia carga directo con el MPN correcto, sin consultas extra.
 */
export function flixmediaCandidatesForVariant(v: {
  skuflixmedia?: string | null;
  descGeneral?: string | null;
  sku?: string | null;
}): string[] {
  const flix = cleanSku(v.skuflixmedia);
  const padre = cleanSku(v.descGeneral);
  const sku = cleanSku(v.sku);
  const ordered =
    flix && flix !== sku ? [flix, padre, sku] : padre ? [padre, flix, sku] : [flix, sku];
  const out: string[] = [];
  for (const c of ordered) {
    if (c && !out.includes(c)) out.push(c);
  }
  return out;
}

/**
 * Elige el MPN a usar entre varios candidatos: el primero (en orden) con
 * contenido según el Match API. Si ninguno matchea, o se agota `maxWaitMs`,
 * devuelve el primero: loader.js/NOSHOW siguen siendo la verificación final.
 * Las consultas siguen en background y quedan cacheadas (24h) para la próxima.
 */
export async function resolveFlixmediaMpn(
  candidates: string[],
  signal?: AbortSignal,
  maxWaitMs?: number
): Promise<{ mpn: string | null; matched: boolean; productId?: string; timedOut?: boolean }> {
  if (candidates.length === 0) return { mpn: null, matched: false };
  const resolution = Promise.all(
    candidates.map((c) => checkFlixmediaAvailability(c, undefined, undefined, signal))
  ).then((results) => {
    const hit = results.findIndex((r) => r.available);
    return hit >= 0
      ? { mpn: candidates[hit], matched: true, productId: results[hit].productId }
      : { mpn: candidates[0], matched: false };
  });
  if (!maxWaitMs) return resolution;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<{ mpn: string; matched: false; timedOut: true }>((resolve) => {
    timer = setTimeout(() => resolve({ mpn: candidates[0], matched: false, timedOut: true }), maxWaitMs);
  });
  try {
    return await Promise.race([resolution, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Prefetch del script de Flixmedia para mejorar la velocidad de carga
 */
export function prefetchFlixmediaScript() {
  if (typeof window === 'undefined') return;

  if (
    document.querySelector('link[href*="flixfacts.com/js/loader.js"]') ||
    document.querySelector('script[src*="flixfacts.com/js/loader.js"]')
  ) {
    return;
  }

  const link = document.createElement('link');
  link.rel = 'preload';
  link.as = 'script';
  link.href = '//media.flixfacts.com/js/loader.js';
  document.head.appendChild(link);
}

/**
 * Precarga el script de Flixmedia al cargar la página
 */
export function preloadFlixmediaScriptEarly() {
  if (typeof window === 'undefined') return;

  const dnsPrefetch = document.createElement('link');
  dnsPrefetch.rel = 'dns-prefetch';
  dnsPrefetch.href = '//media.flixfacts.com';
  document.head.appendChild(dnsPrefetch);

  const preconnect = document.createElement('link');
  preconnect.rel = 'preconnect';
  preconnect.href = 'https://media.flixfacts.com';
  preconnect.crossOrigin = 'anonymous';
  document.head.appendChild(preconnect);

  prefetchFlixmediaScript();
}

/**
 * Verifica si un producto tiene contenido premium (imágenes o videos)
 * Utilidad compartida entre FlixmediaPlayer y la página multimedia
 */
export function hasPremiumContent(
  apiProduct?: {
    imagenPremium?: string[][];
    videoPremium?: string[][];
    imagen_premium?: string[][];
    video_premium?: string[][];
  },
  productColors?: Array<{
    imagen_premium?: string[];
    video_premium?: string[];
  }>
): boolean {
  const checkArrayOfArrays = (arr?: string[][]): boolean => {
    if (!arr || !Array.isArray(arr)) return false;
    return arr.some((innerArray: string[]) => {
      if (!Array.isArray(innerArray) || innerArray.length === 0) return false;
      return innerArray.some(item => item && typeof item === 'string' && item.trim() !== '');
    });
  };

  const hasApiPremiumContent =
    checkArrayOfArrays(apiProduct?.imagenPremium) ||
    checkArrayOfArrays(apiProduct?.videoPremium) ||
    checkArrayOfArrays(apiProduct?.imagen_premium) ||
    checkArrayOfArrays(apiProduct?.video_premium);

  const hasColorPremiumContent = productColors?.some(color => {
    const hasColorImages = color.imagen_premium && Array.isArray(color.imagen_premium) &&
      color.imagen_premium.length > 0 &&
      color.imagen_premium.some(img => img && typeof img === 'string' && img.trim() !== '');
    const hasColorVideos = color.video_premium && Array.isArray(color.video_premium) &&
      color.video_premium.length > 0 &&
      color.video_premium.some(vid => vid && typeof vid === 'string' && vid.trim() !== '');
    return hasColorImages || hasColorVideos;
  }) || false;

  return hasApiPremiumContent || hasColorPremiumContent;
}
