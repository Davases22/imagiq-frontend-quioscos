// Carrusel de imágenes del dispositivo
// Componente reutilizable para mostrar la imagen principal del dispositivo y navegación
'use client';

import React, { useState, useMemo, useEffect } from "react";
import Image, { StaticImageData } from "next/image";
import { motion } from "framer-motion";
import emptyImg from "@/img/empty.jpeg";
import { getCloudinaryUrl } from "@/lib/cloudinary";

// Espejo del `sizes` que useCloudinaryImage genera para 'product-detail'.
// Aquí no usamos el hook porque necesitamos la URL de TODAS las imágenes, no
// solo la actual, y un hook no se puede llamar dentro de un map.
const DETAIL_SIZES = "(max-width: 768px) 100vw, 1000px";

// Tope de portadas de otras variantes a precargar. Con muchos tamaños (un TV
// puede traer 8) precargarlas todas gastaría datos en fotos que quizá no se
// miren; ocho cubre el catálogo real sin pasarse.
const MAX_VARIANT_PRELOADS = 8;

interface DeviceCarouselProps {
  alt: string;
  imagePreviewUrl?: string;
  imageDetailsUrls?: string[];
  /** Portada de TODAS las variantes del producto, en el orden del API. Las que
   *  no son la actual se montan ocultas para que al cambiar de tamaño o color
   *  la foto ya esté descargada en vez de empezar a pedirse en ese momento. */
  allVariantPreviews?: string[];
  onImageClick?: (images: (string | StaticImageData)[], currentIndex: number) => void;
}

/**
 * Carrusel de dispositivo con imagen y navegación funcional.
 */
const DeviceCarousel: React.FC<DeviceCarouselProps> = ({
  alt,
  imagePreviewUrl,
  imageDetailsUrls = [],
  allVariantPreviews = [],
  onImageClick,
}) => {
  const [currentImageIndex, setCurrentImageIndex] = useState(0);

  // Clave estable del contenido: el padre reconstruye el array en cada render,
  // así que comparar por referencia haría inútil el useMemo.
  const detailsKey = imageDetailsUrls.filter((url) => url && url.trim() !== "").join("|");

  // Construir array de imágenes: imagePreviewUrl primero, luego imageDetailsUrls
  const images = useMemo<(string | StaticImageData)[]>(() => {
    const list: (string | StaticImageData)[] = [];

    // Agregar imagePreviewUrl como primera imagen si existe y no está vacío
    if (imagePreviewUrl && imagePreviewUrl.trim() !== "") {
      list.push(imagePreviewUrl);
    }

    // Agregar imageDetailsUrls, filtrando URLs vacías
    if (detailsKey) {
      list.push(...detailsKey.split("|"));
    }

    // Si no hay imágenes válidas del backend, usar empty.jpg
    return list.length > 0 ? list : [emptyImg];
  }, [imagePreviewUrl, detailsKey]);

  // URL optimizada de CADA imagen, no solo la actual: todas se montan a la vez
  // para que el navegador ya las tenga cuando el comprador pase de foto.
  const optimizedSrcs = useMemo(
    () =>
      images.map((image) =>
        getCloudinaryUrl(
          typeof image === "string" ? image : image.src,
          "product-detail"
        )
      ),
    [images]
  );

  // Al cambiar de color o tamaño llega otra lista; si la nueva es más corta, el
  // índice viejo apuntaría fuera del array.
  useEffect(() => {
    setCurrentImageIndex(0);
  }, [images]);

  // Misma razón que arriba para la clave: el array llega nuevo en cada render.
  const previewsKey = allVariantPreviews.filter(Boolean).join("|");

  // Portadas de las OTRAS variantes. Al cambiar de tamaño o color la galería
  // recibe una lista de fotos completamente nueva, que hasta ese momento nadie
  // había pedido: por eso quedaba en blanco aunque el carrusel de la variante
  // actual ya estuviera resuelto.
  const variantPreloads = useMemo(() => {
    if (!previewsKey) return [];
    const yaVisibles = new Set(optimizedSrcs);
    const out: string[] = [];
    for (const url of previewsKey.split("|")) {
      const optimizada = getCloudinaryUrl(url, "product-detail");
      if (yaVisibles.has(optimizada) || out.includes(optimizada)) continue;
      out.push(optimizada);
      if (out.length >= MAX_VARIANT_PRELOADS) break;
    }
    return out;
  }, [previewsKey, optimizedSrcs]);

  const goToPrevious = () => {
    setCurrentImageIndex((prev) => (prev === 0 ? images.length - 1 : prev - 1));
  };
  
  const goToNext = () => {
    setCurrentImageIndex((prev) => (prev === images.length - 1 ? 0 : prev + 1));
  };
  
  const goToImage = (index: number) => {
    setCurrentImageIndex(index);
  };

  // Máximo de miniaturas visibles antes de mostrar "+X más"
  const maxVisibleThumbnails = 5;
  const hasMoreImages = images.length > maxVisibleThumbnails;
  const visibleImages = hasMoreImages ? images.slice(0, maxVisibleThumbnails) : images;
  const remainingCount = images.length - maxVisibleThumbnails;

  return (
    <motion.div
      className="w-full"
      initial={{ opacity: 0, y: -20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5, ease: [0.25, 0.1, 0.25, 1] }}
    >
      {/* Carrusel con fondo gris */}
      <div className="relative rounded-2xl px-4 py-4 w-full bg-gray-50 overflow-hidden">
        {/* Flechas de navegación */}
        {images.length > 1 && (
          <>
            <button
              className="absolute left-4 top-1/2 transform -translate-y-1/2 text-gray-400 hover:text-gray-600 text-4xl z-10 transition-colors w-12 h-12 flex items-center justify-center rounded-full hover:bg-white/80"
              aria-label="Imagen anterior"
              onClick={goToPrevious}
            >
              ‹
            </button>
            <button
              className="absolute right-4 top-1/2 transform -translate-y-1/2 text-gray-400 hover:text-gray-600 text-4xl z-10 transition-colors w-12 h-12 flex items-center justify-center rounded-full hover:bg-white/80"
              aria-label="Imagen siguiente"
              onClick={goToNext}
            >
              ›
            </button>
          </>
        )}

        {/* Imagen del dispositivo con altura aumentada */}
        <button
          type="button"
          className="flex justify-center h-[400px] sm:h-[450px] md:h-[500px] w-full items-center relative cursor-pointer group overflow-hidden"
          onClick={() => onImageClick?.(images, currentImageIndex)}
          aria-label={`Mostrar imagen ${currentImageIndex + 1} de ${alt}`}
        >
          {/* Todas las fotos quedan montadas y se cruzan por opacidad. Antes se
              desmontaba la anterior y se montaba la siguiente (AnimatePresence
              con mode="wait"): la foto nueva empezaba a descargarse recién al
              pasar, y el desvanecimiento de la vieja terminaba ANTES de que la
              nueva entrara, dejando el fondo gris a la vista aunque la imagen ya
              estuviera en caché.
              `fill` + object-contain para centrar por CSS sin recortar. */}
          <div className="relative w-full h-full">
            {optimizedSrcs.map((src, index) => (
              <Image
                key={`${src}-${index}`}
                src={src}
                alt={`${alt} - Imagen ${index + 1}`}
                fill
                className={`object-contain object-center transition-opacity duration-300 ease-out ${
                  index === currentImageIndex ? "opacity-100" : "opacity-0"
                }`}
                sizes={DETAIL_SIZES}
                priority={index === 0}
                loading={index === 0 ? undefined : "eager"}
                aria-hidden={index !== currentImageIndex}
              />
            ))}
            {/* Nunca se ven: están montadas solo para que el navegador las baje.
                Se montan como <Image> y no con una precarga a mano porque
                next/image sirve por /_next/image?url=...&w=...; precargar la URL
                de Cloudinary directo descargaría otro archivo y no serviría.
                fetchPriority low para no competir con la foto que se está
                mirando ahora. */}
            {variantPreloads.map((src) => (
              <Image
                key={`preload-${src}`}
                src={src}
                alt=""
                fill
                className="object-contain object-center opacity-0 pointer-events-none"
                sizes={DETAIL_SIZES}
                loading="eager"
                fetchPriority="low"
                aria-hidden
              />
            ))}
          </div>
        </button>
      </div>
      
      {/* Miniaturas de imágenes - Fuera del fondo gris */}
      {images.length > 1 && (
        <div className="flex justify-center gap-2 mt-4 px-4">
          {visibleImages.map((image, index) => {
            // Obtener src de la imagen
            const thumbnailSrc = typeof image === 'string' ? image : image.src;

            return (
              <button
                key={`thumbnail-${index}-${typeof image === 'string' ? image : 'static'}`}
                className={`relative w-16 h-16 sm:w-20 sm:h-20 rounded-lg overflow-hidden transition-all border-2 flex-shrink-0 ${
                  index === currentImageIndex 
                    ? "border-black shadow-md scale-105" 
                    : "border-gray-200 hover:border-gray-400 opacity-70 hover:opacity-100"
                }`}
                onClick={() => goToImage(index)}
                aria-label={`Ver imagen ${index + 1}`}
              >
                <Image
                  src={thumbnailSrc}
                  alt={`${alt} - Miniatura ${index + 1}`}
                  fill
                  className="object-cover"
                  sizes="80px"
                />
              </button>
            );
          })}
          
          {/* Indicador de más imágenes */}
          {hasMoreImages && (
            <button
              className="relative w-16 h-16 sm:w-20 sm:h-20 rounded-lg overflow-hidden transition-all border-2 border-gray-200 hover:border-gray-400 flex-shrink-0 flex items-center justify-center bg-gray-100 hover:bg-gray-200"
              onClick={() => onImageClick?.(images, maxVisibleThumbnails)}
              aria-label={`Ver ${remainingCount} imágenes más`}
            >
              <span className="text-xs sm:text-sm font-semibold text-gray-600">
                +{remainingCount} más
              </span>
            </button>
          )}
        </div>
      )}
    </motion.div>
  );
};

export default DeviceCarousel;
