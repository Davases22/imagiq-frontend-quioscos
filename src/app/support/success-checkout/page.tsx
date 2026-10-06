"use client";

/**
 * Confirmación de pago de una orden de soporte.
 *
 * Esta pantalla existía desde antes pero no la usaba nadie: al aprobarse el
 * pago, `/support/verify-purchase/[id]` devolvía al cliente al inicio de
 * soporte con un aviso diminuto en una esquina. Después de pagar la reparación
 * de un equipo —varios cientos de miles de pesos— esa confirmación no se veía.
 *
 * No redirige sola. La versión anterior saltaba al inicio de soporte a los 8
 * segundos, y ese es justo el momento en que el cliente está anotando el número
 * de orden o tomando una captura para el técnico.
 */

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense } from "react";

function Contenido() {
  const params = useSearchParams();
  const orderId = params?.get("orderId");

  return (
    <main className="min-h-dvh flex items-center justify-center bg-neutral-50 px-4 py-12">
      <div className="w-full max-w-md rounded-2xl bg-white p-8 text-center shadow-sm ring-1 ring-black/5">
        <div
          className="mx-auto mb-6 flex h-16 w-16 items-center justify-center rounded-full bg-emerald-50"
          aria-hidden="true"
        >
          <svg
            width="32"
            height="32"
            viewBox="0 0 24 24"
            fill="none"
            stroke="#059669"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M20 6 9 17l-5-5" />
          </svg>
        </div>

        <h1 className="mb-3 text-2xl font-bold text-balance text-neutral-900">
          ¡Pago exitoso!
        </h1>

        <p className="mb-6 text-sm leading-relaxed text-neutral-600">
          Recibimos tu pago. Te enviamos el comprobante al correo y el servicio
          técnico ya puede continuar con tu equipo.
        </p>

        {orderId && (
          <div className="mb-6 rounded-xl bg-neutral-50 px-4 py-3">
            <p className="text-xs text-neutral-500">Número de orden</p>
            <p className="font-mono text-base font-semibold text-neutral-900">
              {orderId}
            </p>
          </div>
        )}

        <div className="flex flex-col gap-2">
          <Link
            href="/soporte/inicio_de_soporte"
            className="w-full rounded-full bg-black px-6 py-3 text-sm font-bold text-white transition-colors hover:bg-neutral-800"
          >
            Volver a soporte
          </Link>
          <Link
            href="/"
            className="w-full rounded-full border border-neutral-300 px-6 py-3 text-sm font-semibold text-neutral-900 transition-colors hover:bg-neutral-50"
          >
            Ir al inicio
          </Link>
        </div>

        <p className="mt-6 text-xs leading-relaxed text-neutral-500">
          Guarda el número de orden: es el que te piden para consultar el estado
          de tu reparación.
        </p>
      </div>
    </main>
  );
}

export default function SupportSuccessPage() {
  // useSearchParams obliga a un Suspense para no romper el prerender.
  return (
    <Suspense fallback={<div className="min-h-dvh bg-neutral-50" />}>
      <Contenido />
    </Suspense>
  );
}
