"use client";

import React, { forwardRef, useState, useRef, useEffect } from "react";
import { ProductCardProps } from "@/app/productos/components/ProductCard";

// Tope de fotos a precargar. Los productos premium pueden traer muchos assets y
// precargarlos todos gastaría datos en material que quizá no se mire.
const MAX_PRELOAD = 12;

function isVideoUrl(src: string | undefined): boolean {
  if (!src) return false;
  return (
    src.includes(".webm") ||
    src.includes(".mp4") ||
    src.includes(".mov") ||
    src.includes("video/upload")
  );
}

interface ProductCarouselProps {
  product: ProductCardProps;
  selectedColor: string | null;
  currentImageIndex: number;
  setCurrentImageIndex: React.Dispatch<React.SetStateAction<number>>;
  showStickyCarousel: boolean;
  premiumImages: string[];
  productImages: string[];
  onOpenModal: () => void;
  setSelectedColor: React.Dispatch<React.SetStateAction<string | null>>;
}

// Componente para manejar videos con control de reproducción
const VideoPlayer: React.FC<{
  src: string;
  alt: string;
  onVideoEnd?: () => void;
  onVideoStart?: () => void;
  isPlaying?: boolean;
  onTogglePlayState?: (isPlaying: boolean) => void;
}> = ({
  src,
  onVideoEnd,
  onVideoStart,
  isPlaying = false,
  onTogglePlayState,
}) => {
  const [videoError, setVideoError] = useState(false);
  const [hasPlayed, setHasPlayed] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);

  // Usar directamente el tag video HTML5 para mejor compatibilidad
  if (videoError) {
    return (
      <div className="w-full h-full flex items-center justify-center bg-gray-100">
        <div className="text-center text-gray-500">
          <div className="text-4xl mb-2">🎥</div>
          <div>Video no disponible</div>
        </div>
      </div>
    );
  }

  const handlePlayPause = async () => {
    const video = videoRef.current;
    if (!video) return;

    try {
      if (video.paused) {
        await video.play();
        onTogglePlayState?.(true);
      } else {
        video.pause();
        onTogglePlayState?.(false);
      }
    } catch (error) {
      console.warn("Error al alternar reproducción:", error);
    }
  };

  return (
    <div className="relative w-full h-full">
      <div className="relative w-full h-full flex items-center justify-center">
        <video
          ref={videoRef}
          src={src}
          autoPlay={!hasPlayed}
          loop={false}
          muted
          playsInline
          controls={false}
          className="w-full h-full object-contain"
          onEnded={() => {
            setHasPlayed(true);
            onVideoEnd?.();
            onTogglePlayState?.(false);
          }}
          onPlay={() => {
            setHasPlayed(true);
            onVideoStart?.();
            onTogglePlayState?.(true);
          }}
          onPause={() => {
            onTogglePlayState?.(false);
          }}
          onError={(e) => {
            console.error('Error loading video:', src, e);
            setVideoError(true);
          }}
        />
      </div>
      {/* Botón de pausa/play dentro del video - parte inferior derecha */}
      <button
        onClick={handlePlayPause}
        className="absolute bottom-3 right-5 md:bottom-6 md:right-8 w-8 h-8 md:w-9 md:h-9 rounded-full bg-black/70 hover:bg-black/90 backdrop-blur-sm flex items-center justify-center transition-all hover:scale-110 z-50"
      >
        {isPlaying ? (
          <div className="flex items-center gap-0.5">
            <span className="block w-[3.5px] h-3.5 md:h-4 bg-white rounded-sm" />
            <span className="block w-[3.5px] h-3.5 md:h-4 bg-white rounded-sm" />
          </div>
        ) : (
          <div className="w-0 h-0 border-l-[7px] md:border-l-[8px] border-l-white border-t-[4px] md:border-t-[4.5px] border-t-transparent border-b-[4px] md:border-b-[4.5px] border-b-transparent" />
        )}
      </button>
    </div>
  );
};

const ProductCarousel = forwardRef<HTMLDivElement, ProductCarouselProps>(({
  product,
  selectedColor,
  currentImageIndex,
  setCurrentImageIndex,
  showStickyCarousel,
  premiumImages,
  productImages,
  onOpenModal,
}, ref) => {
  const [isVideoPlaying, setIsVideoPlaying] = useState(false);
  const touchStartX = useRef<number | null>(null);
  const touchEndX = useRef<number | null>(null);

  // Claves por contenido: el padre reconstruye estos arrays en cada render, así
  // que comparar por referencia dispararía la precarga una y otra vez.
  const premiumKey = premiumImages.join("|");
  const productKey = productImages.join("|");

  // Sin esto, cada foto empieza a descargarse recién en el momento en que se
  // pasa a ella y el carrusel se queda vacío mientras llega. Los videos se
  // excluyen a propósito: pesan demasiado para traerlos de entrada.
  useEffect(() => {
    const urls = [...new Set([...premiumImages, ...productImages])]
      .filter((url) => url && !isVideoUrl(url))
      .slice(0, MAX_PRELOAD);

    urls.forEach((url) => {
      const img = new window.Image();
      img.src = url;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [premiumKey, productKey]);

  const handleVideoStart = () => {
    setIsVideoPlaying(true);
  };

  const handleVideoEnd = () => {
    setIsVideoPlaying(false);
  };

  // Handlers para gestos de swipe en móvil
  const handleTouchStart = (e: React.TouchEvent) => {
    touchStartX.current = e.touches[0].clientX;
  };

  const handleTouchMove = (e: React.TouchEvent) => {
    touchEndX.current = e.touches[0].clientX;
  };

  const handleTouchEnd = () => {
    if (!touchStartX.current || !touchEndX.current) return;

    const distance = touchStartX.current - touchEndX.current;
    const minSwipeDistance = 50; // Distancia mínima para considerar un swipe

    // Determinar qué imágenes usar
    const currentImages = showStickyCarousel ? premiumImages : productImages;

    if (currentImages.length <= 1) return;

    if (Math.abs(distance) > minSwipeDistance) {
      if (distance > 0) {
        // Swipe hacia la izquierda - siguiente imagen
        setCurrentImageIndex((prev) => (prev + 1) % currentImages.length);
      } else {
        // Swipe hacia la derecha - imagen anterior
        setCurrentImageIndex((prev) => (prev === 0 ? currentImages.length - 1 : prev - 1));
      }
    }

    // Resetear valores
    touchStartX.current = null;
    touchEndX.current = null;
  };

  return (
    <div ref={ref} className="w-full relative zoom-safe-container px-2 sm:px-4 pb-10 md:pb-12">
      {/* Carrusel premium - estilo Samsung más grande */}
      <div className={`relative w-full pt-8 md:pt-6 transition-all duration-700 ease-in-out ${showStickyCarousel ? 'opacity-100 scale-100' : 'opacity-0 scale-95 pointer-events-none'}`}>
        {(() => {
          // Determinar qué imágenes usar según el estado del scroll
          // Para el carrusel premium, usar SOLO las imágenes del API (sin contenido mockeado)
          const currentImages = showStickyCarousel
            ? premiumImages
            : productImages;
          const currentImageSet = showStickyCarousel ? 'premium' : 'product';

          return currentImages.length > 0 ? (() => {
            const currentSrc = currentImages[currentImageIndex];
            const isVideo = isVideoUrl(currentSrc);

            return (
            <div
              className="relative w-full"
              style={{
                paddingTop: "clamp(0.75rem, 2vw, 1.5rem)",
                paddingBottom: "clamp(1rem, 3vw, 3rem)",
              }}
            >
              {/* Imagen principal - estilo Samsung más grande */}
              <div 
                className={`relative w-full bg-transparent flex items-center justify-center ${isVideo ? 'overflow-visible' : 'overflow-hidden'} zoom-safe-media`}
                onTouchStart={handleTouchStart}
                onTouchMove={handleTouchMove}
                onTouchEnd={handleTouchEnd}
              >
                {(() => {
                  if (isVideo) {
                    return (
                      <div className="relative w-full h-full flex items-center justify-center">
                        <VideoPlayer
                          src={currentSrc}
                          alt={`${product.name} - ${
                            currentImageSet === "premium" ? "Premium" : "Producto"
                          } ${currentImageIndex + 1}`}
                          onVideoStart={handleVideoStart}
                          onVideoEnd={handleVideoEnd}
                          isPlaying={isVideoPlaying}
                          onTogglePlayState={setIsVideoPlaying}
                        />
                      </div>
                    );
                  } else {
                    return (
                      // Sin `key` por src a propósito: forzaba a React a montar un
                      // <img> NUEVO en cada cambio, y un nodo recién montado nace
                      // vacío. Reutilizando el mismo nodo el navegador deja la foto
                      // anterior pintada hasta que la siguiente está lista.
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={currentSrc}
                        alt={`${product.name} - ${currentImageSet === 'premium' ? 'Premium' : 'Producto'} ${currentImageIndex + 1}`}
                        className="w-full h-full object-contain"
                        onError={(e) => {
                          console.error('Error loading image:', currentSrc, e);
                        }}
                      />
                    );
                  }
                })()}

                {/* Flechas de navegación - estilo Samsung - solo en desktop */}
                {currentImages.length > 1 && (
                  <>
                    <button
                      onClick={() => setCurrentImageIndex((prev) => prev === 0 ? currentImages.length - 1 : prev - 1)}
                      className="hidden md:flex absolute left-4 top-1/2 -translate-y-1/2 w-12 h-12 rounded-full bg-white/95 hover:bg-white shadow-lg items-center justify-center transition-all hover:scale-105"
                    >
                      <svg className="w-6 h-6 text-gray-800" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
                      </svg>
                    </button>
                    <button
                      onClick={() => setCurrentImageIndex((prev) => (prev + 1) % currentImages.length)}
                      className="hidden md:flex absolute right-4 top-1/2 -translate-y-1/2 w-12 h-12 rounded-full bg-white/95 hover:bg-white shadow-lg items-center justify-center transition-all hover:scale-105"
                    >
                      <svg className="w-6 h-6 text-gray-800" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                      </svg>
                    </button>
                  </>
                )}
              </div>

              {/* Puntos de navegación */}
              {currentImages.length > 1 && (
                <>
                  {/* Indicadores mobile/tablet */}
                  <div className="w-full flex justify-center lg:hidden">
                  <div
                    className="flex justify-center items-center zoom-safe-dots"
                    style={{
                      marginTop: "clamp(0.5rem, 1.5vw, 1rem)",
                      marginBottom: "clamp(0.75rem, 2vw, 1.5rem)",
                    }}
                  >
                      {currentImages.map((_, index) => (
                        <button
                          key={index}
                          onClick={() => setCurrentImageIndex(index)}
                          className={`zoom-safe-dot ${
                            index === currentImageIndex
                              ? "zoom-safe-dot-active"
                              : "zoom-safe-dot-inactive"
                          }`}
                        />
                      ))}
                    </div>
                  </div>

                  {/* Indicadores desktop */}
                  <div className="hidden lg:block">
                    <div className="absolute left-1/2 bottom-0 -translate-x-1/2 translate-y-[200%] z-40">
                      <div className="flex justify-center items-center zoom-safe-dots">
                        {currentImages.map((_, index) => (
                          <button
                            key={index}
                            onClick={() => setCurrentImageIndex(index)}
                            className={`zoom-safe-dot ${
                              index === currentImageIndex
                                ? "zoom-safe-dot-active"
                                : "zoom-safe-dot-inactive"
                            }`}
                          />
                        ))}
                      </div>
                    </div>
                  </div>
                </>
              )}
            </div>
            );
          })() : (
            <div className="w-full h-[220px] md:h-[700px] bg-transparent flex items-center justify-center text-gray-500 text-lg font-semibold">
              <div className="text-center">
                <div className="text-6xl mb-4">📱</div>
                <div>Contenido premium no disponible</div>
              </div>
            </div>
          );
        })()}
      </div>

      {/* Segundo carrusel - Solo imágenes del color seleccionado (más pequeño) */}
      <div className={`absolute top-[5%] left-0 right-0 bottom-0 w-full transition-all duration-700 ease-in-out ${!showStickyCarousel ? 'opacity-100 scale-100' : 'opacity-0 scale-105 pointer-events-none'}`}>
        {productImages.length > 0 ? (
          <>
            {/* Imagen del producto - más pequeña y simple con fondo transparente */}
            <div 
              className="relative w-full max-w-4xl mx-auto flex items-center justify-center overflow-hidden zoom-safe-secondary-media px-4 sm:px-8"
              style={{
                height: "min(70vh, 680px)",
                minHeight: "320px",
              }}
              onTouchStart={handleTouchStart}
              onTouchMove={handleTouchMove}
              onTouchEnd={handleTouchEnd}
            >
              {(() => {
                const currentSrc = productImages[currentImageIndex % productImages.length];

                return (
                  <div className="w-full h-full flex items-center justify-center">
                    {/* Mismo criterio que el carrusel de arriba: sin `key` por src
                        para no remontar el nodo, y sin lazy — esta foto está en
                        pantalla desde que carga la página, así que diferirla solo
                        retrasaba su aparición. */}
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={currentSrc}
                      alt={`${product.name} - ${selectedColor} ${(currentImageIndex % productImages.length) + 1}`}
                      className="w-full h-full object-contain"
                      style={{ maxWidth: "100%", maxHeight: "100%" }}
                      onError={(e) => {
                        console.error('Error loading image:', currentSrc, e);
                      }}
                    />
                  </div>
                );
              })()}
            </div>
            {/* Botón Ver más - estilo Samsung */}
            <div className="flex justify-center -mt-2 md:mt-1">
              <button
                onClick={onOpenModal}
                className="px-6 py-2.5 bg-white text-black border-2 border-black rounded-full text-sm font-medium hover:bg-black hover:text-white transition-all hover:scale-105"
              >
                Ver más
              </button>
            </div>
          </>
        ) : (
          <div className="w-full bg-transparent flex items-center justify-center text-gray-500 text-lg font-semibold rounded-2xl zoom-safe-secondary-media">
            <div className="text-center">
              <div className="text-4xl mb-2">🎨</div>
              <div>No hay fotos específicas para el color {selectedColor}</div>
              <div className="text-sm mt-2">Selecciona otro color para ver más fotos</div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
});

ProductCarousel.displayName = 'ProductCarousel';

export default ProductCarousel;