import React from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import type { FormattedStore } from "@/types/store";
import AddNewAddressForm from "./AddNewAddressForm";
import type { Address } from "@/types/address";
import { NearbyLocationButton } from "./NearbyLocationButton";
import type { Direccion } from "@/types/user";
import Modal from "@/components/ui/Modal";

interface StoreSelectorProps {
  storeQuery: string;
  filteredStores: FormattedStore[];
  selectedStore: FormattedStore | null;
  onQueryChange: (query: string) => void;
  onStoreSelect: (store: FormattedStore) => void;
  storesLoading?: boolean;
  canPickUp?: boolean;
  allStores?: FormattedStore[];
  onAddressAdded?: (address?: Address) => void | Promise<void>;
  onRefreshStores?: () => void;
  availableCities?: string[];
  hasActiveTradeIn?: boolean;
  availableStoresWhenCanPickUpFalse?: FormattedStore[];
  onAddressChange?: (address: Address) => void;
  storeEdit?: boolean;
  onEditToggle?: (edit: boolean) => void;
}


export const StoreSelector: React.FC<StoreSelectorProps> = ({
  storeQuery,
  filteredStores,
  selectedStore,
  onQueryChange,
  onStoreSelect,
  storesLoading = false,
  canPickUp = true,
  allStores = [],
  onAddressAdded,
  onRefreshStores,
  availableCities = [],
  hasActiveTradeIn = false,
  availableStoresWhenCanPickUpFalse = [],
  onAddressChange,
  storeEdit = false,
  onEditToggle,
}) => {
  const [showAddAddressModal, setShowAddAddressModal] = React.useState(false);
  const [isMounted, setIsMounted] = React.useState(false);

  // Verificar si estamos en el cliente
  React.useEffect(() => {
    setIsMounted(true);
  }, []);

  // Función para cerrar el modal
  const handleCloseModal = () => {
    if (onEditToggle) {
      onEditToggle(false);
    }
    setShowAddAddressModal(false);
  };

  // Función para manejar selección de tienda y cerrar modal
  const handleStoreSelect = (store: FormattedStore) => {
    onStoreSelect(store);
    // Cerrar el modal automáticamente después de seleccionar una tienda
    handleCloseModal();
  };

  // Función para manejar cuando se agrega una nueva dirección
  const handleAddressAdded = async (newAddress: Address) => {
    // Llamar a onAddressAdded y esperar si devuelve una promesa (consulta de candidate stores)
    const result = onAddressAdded?.(newAddress);
    if (result instanceof Promise) {
      await result;
    }

    setShowAddAddressModal(false);

    // Recargar las tiendas candidatas con la nueva dirección predeterminada
    if (onRefreshStores) {
      onRefreshStores();
    }

    // Disparar evento para limpiar caché y recalcular tiendas candidatas
    // IMPORTANTE: fromHeader: true para forzar recálculo
    globalThis.window.dispatchEvent(new CustomEvent('address-changed', {
      detail: {
        address: newAddress,
        addressId: newAddress.id,
        fromHeader: true
      }
    }));
  };

  // Determinar qué tiendas mostrar cuando canPickUp es false pero hay Trade In activo
  // IMPORTANTE: Siempre usar availableStoresWhenCanPickUpFalse si hay tiendas disponibles
  const storesToShowWhenCanPickUpFalse = hasActiveTradeIn
    ? availableStoresWhenCanPickUpFalse
    : [];

  return (
    <Modal isOpen={storeEdit} onClose={handleCloseModal} size="lg" showCloseButton={false}>
      <div className="space-y-6">
        {/* Header */}
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 pb-4 border-b border-gray-200">
          <h4 className="text-xl font-semibold text-gray-900">
            Selecciona tu tienda
          </h4>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleCloseModal}
              className="text-gray-700 text-sm font-medium hover:text-gray-900 transition flex items-center gap-1.5 px-3 py-2 border border-gray-300 rounded-md hover:bg-gray-50"
            >
              Cancelar
            </button>
          </div>
        </div>

        {/* Contenido */}
        <div className="space-y-4">
          {/* Mostrar skeleton mientras carga */}
          {storesLoading && (
        <div className="p-4 bg-white border-2 border-gray-200 rounded-lg shadow-sm animate-pulse">
          <div className="h-4 bg-gray-200 rounded w-3/4 mb-3"></div>
          <div className="h-3 bg-gray-200 rounded w-full mb-2"></div>
          <div className="h-3 bg-gray-200 rounded w-5/6 mb-4"></div>
          <div className="space-y-2 mb-4">
            <div className="h-16 bg-gray-200 rounded"></div>
            <div className="h-16 bg-gray-200 rounded"></div>
            <div className="h-16 bg-gray-200 rounded"></div>
          </div>
          <div className="h-10 bg-gray-200 rounded"></div>
        </div>
      )}

      {/* Mostrar mensaje de advertencia cuando canPickUp es false Y NO está cargando */}
      {/* IMPORTANTE: Solo mostrar contenido cuando ya terminó de cargar, mientras carga mostrar skeleton */}
      {canPickUp === false && !storesLoading && (
        <div className="p-4 bg-gradient-to-br from-gray-50 to-gray-100 border-2 border-gray-200 rounded-lg shadow-sm">
          {/* Verificar si realmente hay tiendas disponibles */}
          {(() => {
            // IMPORTANTE: Siempre verificar availableStoresWhenCanPickUpFalse primero
            const hasStores = availableStoresWhenCanPickUpFalse.length > 0 || storesToShowWhenCanPickUpFalse.length > 0;
            const hasCities = availableCities.length > 0;
            const reallyNoStores = !hasStores && !hasCities;

            // Si NO hay tiendas, mostrar mensaje de "no hay tiendas"
            if (reallyNoStores) {
              return (
                <>
                  <p className="text-sm font-bold text-gray-900 mb-2">
                    {hasActiveTradeIn
                      ? "No hay tiendas disponibles para recoger este producto."
                      : "Tu ubicación predeterminada no cuenta con tiendas disponibles para este producto."}
                  </p>
                  {!hasActiveTradeIn && (
                    <>
                      <div className="mb-3 p-3 bg-blue-50 border border-blue-200 rounded-lg">
                        <p className="text-xs text-gray-800 mb-2">
                          💡 <strong>Tip:</strong> Al cambiar tu dirección predeterminada se recalcularán las tiendas disponibles cercanas a tu nueva ubicación.
                        </p>
                      </div>
                      <p className="text-xs text-gray-700 mb-3">
                        Por favor selecciona otra dirección o agrega una nueva dirección en una zona con cobertura.
                      </p>
                      <button
                        type="button"
                        onClick={() => {
                          // Disparar el menú de direcciones del navbar
                          if (typeof window !== 'undefined') {
                            const addressButton = document.querySelector('[data-address-trigger]');
                            if (addressButton) {
                              (addressButton as HTMLElement).click();
                            } else {
                              alert('Por favor, cambia tu dirección desde el navbar (esquina superior derecha)');
                            }
                          }
                        }}
                        className="w-full bg-blue-600 hover:bg-blue-700 text-white text-sm font-semibold py-2 px-4 rounded-lg transition mb-3"
                      >
                        📍 Cambiar o agregar dirección
                      </button>
                    </>
                  )}
                  {hasActiveTradeIn && (
                    <>
                      <div className="mb-3 p-3 bg-blue-50 border border-blue-200 rounded-lg">
                        <p className="text-xs text-gray-800 mb-2">
                          💡 <strong>Tip:</strong> Al cambiar tu dirección predeterminada se recalcularán las tiendas disponibles cercanas a tu nueva ubicación.
                        </p>
                      </div>
                      <div className="mt-3 p-3 bg-blue-50 border border-blue-200 rounded-lg mb-3">
                        <p className="text-sm text-gray-800">
                          Actualmente los productos de tu carrito no se encuentran disponibles para recoger en un punto físico.
                        </p>
                      </div>
                      <button
                        type="button"
                        onClick={() => {
                          // Disparar el menú de direcciones del navbar
                          if (typeof window !== 'undefined') {
                            const addressButton = document.querySelector('[data-address-trigger]');
                            if (addressButton) {
                              (addressButton as HTMLElement).click();
                            } else {
                              alert('Por favor, cambia tu dirección desde el navbar (esquina superior derecha)');
                            }
                          }
                        }}
                        className="w-full bg-blue-600 hover:bg-blue-700 text-white text-sm font-semibold py-2 px-4 rounded-lg transition mb-3"
                      >
                        📍 Cambiar o agregar dirección
                      </button>
                    </>
                  )}
                </>
              );
            }

            // Si HAY tiendas, mostrar mensaje de advertencia y luego las tiendas
            // IMPORTANTE: Usar siempre availableStoresWhenCanPickUpFalse cuando haya tiendas disponibles
            const storesToDisplay = availableStoresWhenCanPickUpFalse;

            return (
              <>
                {/* Siempre mostrar mensaje de advertencia cuando canPickUp es false */}
                <p className="text-sm font-bold text-gray-900 mb-2">
                  Tu ubicación predeterminada no cuenta con tiendas disponibles para este producto.
                </p>

                <p className="text-xs text-gray-700 mb-3">
                  Por favor cambia o agrega una dirección predeterminada con una tienda cercana.
                </p>

                {/* Mensaje de tiendas disponibles */}
                <p className="text-sm font-semibold text-gray-900 mb-3">
                  El producto está disponible en las siguientes tiendas:
                </p>

                {/* Mostrar tiendas disponibles cuando hay tiendas */}
                {storesToDisplay.length > 0 && (
                  <>
                    <div className="space-y-2 mb-3 max-h-[308px] overflow-y-auto">
                      {storesToDisplay.map((store) => (
                        <div
                          key={store.codigo}
                          className="p-2 bg-gradient-to-r from-blue-50 to-indigo-50 rounded-lg border border-blue-200"
                        >
                          <div className="font-semibold text-sm text-gray-900">{store.descripcion}</div>
                          <div className="text-xs text-gray-600 mt-0.5">
                            {store.direccion}{store.ciudad ? `, ${store.ciudad}` : ''}
                          </div>
                          {store.ubicacion_cc && (
                            <div className="text-xs text-gray-500 mt-0.5">{store.ubicacion_cc}</div>
                          )}
                        </div>
                      ))}
                    </div>
                  </>
                )}

                {/* Fallback: Si solo hay ciudades pero no tiendas, mostrar ciudades */}
                {availableCities.length > 0 && storesToDisplay.length === 0 && (
                  <div className="mb-3 p-2 bg-white rounded border border-gray-200">
                    <p className="text-xs font-semibold text-gray-900 mb-1">
                      El producto está disponible en las siguientes ciudades:
                    </p>
                    <div className="flex flex-wrap gap-1">
                      {availableCities.map((city) => (
                        <span
                          key={city}
                          className="inline-block px-2 py-1 text-xs font-medium bg-blue-50 text-blue-700 rounded border border-blue-200"
                        >
                          {city}
                        </span>
                      ))}
                    </div>
                  </div>
                )}

                {/* Botón "Cerca de mí" para usar geolocalización */}
                <div className="space-y-3">
                  <NearbyLocationButton
                    onAddressAdded={(newAddress: Address) => {
                      // Actualizar la dirección y refrescar tiendas
                      if (onAddressChange) {
                        onAddressChange(newAddress);
                      }

                      // Refrescar tiendas para recalcular con la nueva dirección
                      if (onRefreshStores) {
                        setTimeout(() => {
                          onRefreshStores();
                        }, 500);
                      }
                    }}
                  />

                  <div className="relative flex items-center">
                    <div className="flex-grow border-t border-gray-300"></div>
                    <span className="flex-shrink mx-4 text-gray-500 text-sm">o</span>
                    <div className="flex-grow border-t border-gray-300"></div>
                  </div>
                </div>

                {/* Botón para agregar dirección manualmente (DESPUÉS del botón "Cerca de mí") */}
                <button
                  onClick={() => setShowAddAddressModal(true)}
                  className="w-full px-4 py-2.5 bg-[#222] hover:bg-[#333] text-white rounded-lg text-sm font-semibold transition flex items-center justify-center gap-2"
                  type="button"
                >
                  <span className="text-white text-lg">+</span>
                  <span>Agregar nueva dirección</span>
                </button>
              </>
            );
          })()}
        </div>
      )}

      {/* IMPORTANTE: Mostrar selector de tiendas SOLO cuando canPickUp es true */}
      {canPickUp && (
        <>
          <div className="flex gap-2">
            <input
              type="text"
              className="flex-1 border rounded-lg px-3 py-2 text-sm cursor-text"
              placeholder="Buscar tienda por nombre, ciudad o centro comercial..."
              value={storeQuery}
              onChange={(e) => {
                onQueryChange(e.target.value);
              }}
              disabled={storesLoading}
            />
          </div>

          <div className="max-h-[420px] overflow-y-auto border rounded-lg bg-white shadow">
            {(() => {
              if (storesLoading) {
                return (
                  <div className="p-4 text-gray-500 text-sm">
                    Cargando tiendas...
                  </div>
                );
              }

              // IMPORTANTE: Como este selector solo se muestra cuando canPickUp es true, usar siempre filteredStores
              const storesToDisplay = filteredStores;
              const allStoresToCheck = allStores;

              // IMPORTANTE: Verificar si realmente hay tiendas disponibles
              const hasStores = allStoresToCheck.length > 0;
              const hasFilteredResults = storesToDisplay.length > 0;

              if (!hasFilteredResults) {
                // Si hay una búsqueda activa y hay tiendas pero no coinciden con la búsqueda
                if (storeQuery.trim() !== "" && hasStores) {
                  return (
                    <div className="p-4 text-gray-500 text-sm">
                      No se encontraron tiendas que coincidan con &quot;{storeQuery}&quot;.
                    </div>
                  );
                }
                // Si no hay búsqueda y no hay tiendas disponibles
                if (!hasStores) {
                  return (
                    <div className="p-4 text-gray-500 text-sm">
                      {hasActiveTradeIn
                        ? "El producto seleccionado no cuenta con un punto físico disponible para recoger en tienda."
                        : "No se encontraron tiendas disponibles."}
                    </div>
                  );
                }
              }

              // Si hay resultados filtrados, mostrarlos
              return storesToDisplay.map((store) => {
                const isSelected = selectedStore?.codigo === store.codigo;
                return (
                  <button
                    key={store.codigo}
                    type="button"
                    className={`w-full text-left p-3 cursor-pointer hover:bg-blue-50 ${isSelected ? "bg-blue-100" : ""
                      }`}
                    onClick={() => handleStoreSelect(store)}
                  >
                    <div className="font-semibold text-sm">{store.descripcion}</div>
                    <div className="text-xs text-gray-600">
                      {store.direccion}, {store.ciudad}
                    </div>
                    {store.ubicacion_cc && (
                      <div className="text-xs text-gray-400">{store.ubicacion_cc}</div>
                    )}
                  </button>
                );
              });
            })()}
          </div>
        </>
      )}

        {/* Modal para agregar dirección - usando Portal para renderizar fuera del componente */}
        {showAddAddressModal && isMounted && createPortal(
          <div className="fixed inset-0 z-[100001] flex items-center justify-center p-4 bg-black/60 backdrop-blur-[2px]">
            <button
              type="button"
              aria-label="Cerrar modal"
              className="absolute inset-0 w-full h-full border-0 bg-transparent p-0 cursor-default"
              onClick={() => setShowAddAddressModal(false)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  setShowAddAddressModal(false);
                }
              }}
            />
            <div
              aria-labelledby="modal-title"
              className="relative bg-white rounded-lg shadow-2xl w-full max-w-3xl max-h-[85vh] supports-[height:100dvh]:max-h-[85dvh] flex flex-col"
            >
              <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200 flex-shrink-0">
                <h2 id="modal-title" className="text-xl font-semibold text-gray-900">
                  Agregar nueva dirección
                </h2>
                <button
                  onClick={() => setShowAddAddressModal(false)}
                  className="p-2 hover:bg-gray-100 rounded-full transition-colors"
                  type="button"
                >
                  <X className="w-5 h-5 text-gray-500" />
                </button>
              </div>

              <div className="overflow-y-auto p-6">
                <AddNewAddressForm
                  onAddressAdded={handleAddressAdded}
                  onCancel={() => setShowAddAddressModal(false)}
                  withContainer={false}
                />
              </div>
            </div>
          </div>,
          document.body
        )}
        </div>
      </div>
    </Modal>
  );
};
