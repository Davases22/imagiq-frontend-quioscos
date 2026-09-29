"use client";

import Image from "next/image";

export function HeroSection() {
  return (
    <div className="w-full flex justify-center">
      {/* El banner es 1440x300 (relacion 4.8:1). En movil, `object-contain`
          lo encogia a ~81px de alto y dejaba franjas blancas arriba y abajo,
          asi que el titulo blanco caia sobre fondo blanco y no se leia.
          En movil se recorta al lado izquierdo (logo de WhatsApp + celular)
          para que ocupe todo el alto; desde md se muestra completo. */}
      <div className="relative w-full max-w-[1400px] h-[260px] md:h-[320px] lg:h-[340px] overflow-hidden bg-[#626f80] md:bg-transparent">
        <Image
          src="https://res.cloudinary.com/dcljjtnxr/image/upload/v1760419926/banner_whatsapp_1440x300_pc_yjad0q.jpg"
          alt="WhatsApp Samsung Support Banner"
          fill
          sizes="(max-width: 768px) 100vw, 1400px"
          className="object-cover object-left md:object-contain md:object-center"
          priority
        />

        {/* Solo en movil: oscurece la parte baja para que el titulo blanco
            tenga contraste incluso encima del logo de WhatsApp. */}
        <div
          className="absolute inset-x-0 bottom-0 h-2/3 z-[5] md:hidden bg-gradient-to-t from-black/60 via-black/25 to-transparent"
          aria-hidden="true"
        />

        {/* Texto sobre el banner, alineado a la izquierda y en una sola línea en pantallas medianas+ */}
        <div className="absolute bottom-5 left-5 right-5 md:bottom-6 md:left-[36%] lg:left-[42%] xl:left-[46%] md:right-auto z-10 text-left px-0 md:px-4">
          <h1 className="text-[26px] leading-tight sm:text-3xl md:text-4xl font-bold text-white drop-shadow-xl md:whitespace-nowrap">
            Ayudarte ahora es más fácil
          </h1>
        </div>
      </div>
    </div>
  );
}
