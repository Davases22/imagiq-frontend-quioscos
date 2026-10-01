"use client";
import React, { useState, useEffect, useMemo } from "react";
import { useRouter } from "next/navigation";
import { Direccion } from "@/types/user";
import Step4OrderSummary from "./components/Step4OrderSummary";
import TradeInCompletedSummary from "@/app/productos/dispositivos-moviles/detalles-producto/estreno-y-entrego/TradeInCompletedSummary";
import { useAuthContext } from "@/features/auth/context";
import { addressesService } from "@/services/addresses.service";
import type { Address } from "@/types/address";
import Modal from "@/components/ui/Modal";
import ConfirmModal from "@/components/ui/ConfirmModal";
import AddNewAddressForm from "./components/AddNewAddressForm";
import { MapPin, Plus, Check, Trash2 } from "lucide-react";
import { safeGetLocalStorage } from "@/lib/localStorage";
import { useCart } from "@/hooks/useCart";
import { validateTradeInProducts, getTradeInValidationMessage } from "./utils/validateTradeIn";
import { toast } from "sonner";

interface Step6Props {
  readonly onBack?: () => void;
  readonly onContinue?: () => void;
}

type BillingType = "natural" | "juridica";

interface BillingData {
  type: BillingType;
  // Campos comunes
  nombre: string;
  documento: string;
  tipoDocumento?: string;
  email: string;
  telefono: string;
  direccion: Direccion | null;

  // Campos específicos de persona jurídica
  razonSocial?: string;
  nit?: string;
  nombreRepresentante?: string;
}

// Normalizar tipo de documento: "CC" -> "C.C.", "CE" -> "C.E.", etc.
function normalizeDocType(raw: string | undefined): string {
  if (!raw) return "C.C.";
  const upper = raw.toUpperCase().replace(/\./g, "").trim();
  const map: Record<string, string> = { CC: "C.C.", CE: "C.E.", NIT: "NIT", PASAPORTE: "PASAPORTE" };
  return map[upper] || raw;
}

export default function Step6({ onBack, onContinue }: Step6Props) {
  const router = useRouter();
  const { user } = useAuthContext();
  const { products, isLoading: isCartLoading } = useCart();

  const [billingType, setBillingType] = useState<BillingType>("natural");
  const [useShippingData, setUseShippingData] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [isProcessing, setIsProcessing] = useState(false);

  // Estados para direcciones
  const [addresses, setAddresses] = useState<Address[]>([]);
  const [selectedAddressId, setSelectedAddressId] = useState<string | null>(
    null
  );
  const [isAddAddressModalOpen, setIsAddAddressModalOpen] = useState(false);
  const [isLoadingAddresses, setIsLoadingAddresses] = useState(false);
  const [deletingAddressId, setDeletingAddressId] = useState<string | null>(null);
  const [addressToDelete, setAddressToDelete] = useState<Address | null>(null);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);

  const [billingData, setBillingData] = useState<BillingData>({
    type: "natural",
    nombre: "",
    documento: "",
    tipoDocumento: "C.C.", // Valor por defecto
    email: "",
    telefono: "",
    direccion: null,
  });

  // Trade-In state management - soporta múltiples productos
  const [tradeInDataMap, setTradeInDataMap] = useState<Record<string, {
    completed: boolean;
    deviceName: string; // Nombre del dispositivo que se entrega
    value: number;
    sku?: string; // SKU del producto que se compra
    name?: string; // Nombre del producto que se compra
    skuPostback?: string; // SKU Postback del producto que se compra
  }>>({});

  // Calcular ahorro total por descuentos de productos
  const productSavings = React.useMemo(() => {
    return products.reduce((total, product) => {
      if (product.originalPrice && product.originalPrice > product.price) {
        const saving = (product.originalPrice - product.price) * product.quantity;
        return total + saving;
      }
      return total;
    }, 0);
  }, [products]);

  // Estado para validación de Trade-In
  const [tradeInValidation, setTradeInValidation] = useState<{
    isValid: boolean;
    productsWithoutRetoma: typeof products;
    hasMultipleProducts: boolean;
    errorMessage?: string;
  }>({ isValid: true, productsWithoutRetoma: [], hasMultipleProducts: false });

  // Validación en tiempo real del formulario para habilitar/deshabilitar botón
  const isFormValid = useMemo(() => {
    // Validaciones comunes
    if (!billingData.nombre.trim()) return false;
    if (!billingData.documento.trim()) return false;
    if (!billingData.email.trim()) return false;
    if (!/\S+@\S+\.\S+/.test(billingData.email)) return false;
    if (!billingData.tipoDocumento?.trim()) return false;
    if (!billingData.telefono.trim()) return false;
    if (!billingData.direccion) return false;

    // Validaciones específicas de persona jurídica
    if (billingType === "juridica") {
      if (!billingData.razonSocial?.trim()) return false;
      if (!billingData.nit?.trim()) return false;
    }

    return true;
  }, [billingData, billingType]);

  // Redirigir si el carrito está vacío después de cargar
  useEffect(() => {
    if (!isCartLoading && products.length === 0) {
      router.push("/carrito");
    }
  }, [isCartLoading, products, router]);

  // Validar Trade-In cuando cambian los productos (solo si el carrito ya cargó)
  useEffect(() => {
    // Solo ejecutar validación si el carrito ya terminó de cargar y hay productos
    if (isCartLoading || products.length === 0) {
      return;
    }

    const validation = validateTradeInProducts(products);
    setTradeInValidation(validation);

    // Si el producto ya no aplica (indRetoma === 0), quitar banner inmediatamente y mostrar notificación
    if (!validation.isValid && validation.errorMessage && validation.errorMessage.includes("Te removimos")) {
      // Limpiar localStorage inmediatamente
      localStorage.removeItem("imagiq_trade_in");

      // Quitar el banner inmediatamente
      setTradeInDataMap({});

      // Mostrar notificación toast
      toast.error("Cupón removido", {
        description: "El producto seleccionado ya no aplica para el beneficio Estreno y Entrego",
        duration: 5000,
      });
    }
  }, [products, isCartLoading]);

  // Redirigir a Step3 si la dirección cambia desde el header
  useEffect(() => {
    const handleAddressChange = (event: Event) => {
      const customEvent = event as CustomEvent;
      const fromHeader = customEvent.detail?.fromHeader;

      if (fromHeader) {
        // console.log('🔄 Dirección cambiada desde header en Step6, redirigiendo a Step3...');
        router.push('/carrito/step3');
      }
    };

    window.addEventListener('address-changed', handleAddressChange as EventListener);

    return () => {
      window.removeEventListener('address-changed', handleAddressChange as EventListener);
    };
  }, [router]);

  // Convertir Address a Direccion
  const addressToDireccion = (address: Address): Direccion => {
    return {
      id: address.id,
      usuario_id: address.usuarioId,
      email: user?.email || "",
      linea_uno: address.direccionFormateada,
      codigo_dane: "",
      ciudad: address.ciudad || "",
      pais: address.pais,
      esPredeterminada: address.esPredeterminada,
      // Campos adicionales
      googleUrl: address.googleUrl || "",
      googlePlaceId: address.googlePlaceId || "",
      latitud: address.latitud || 0,
      longitud: address.longitud || 0,
      localidad: address.localidad || "",
      barrio: address.barrio || "",
      complemento: address.complemento || "",
      instruccionesEntrega: address.instruccionesEntrega || "",
    };
  };

  const handleAddressSelect = (address: Address) => {
    setSelectedAddressId(address.id);
    const direccion = addressToDireccion(address);
    setBillingData((prev) => ({
      ...prev,
      direccion,
    }));
  };

  // Cargar direcciones del usuario - solo mostrar la más reciente
  useEffect(() => {
    const loadAddresses = async () => {
      if (!user) return;

      setIsLoadingAddresses(true);
      try {
        // En modo kiosk, usar el ID del cliente kiosk, no el de la cuenta de tienda
        let userId = "";
        const kioskClientStr = localStorage.getItem("kiosk_client_id");
        if (kioskClientStr) {
          try {
            const kc = JSON.parse(kioskClientStr);
            userId = kc.userId || kc.id || "";
          } catch { /* ignore */ }
        }
        if (!userId) {
          const userInfo = safeGetLocalStorage<{ id?: string }>("imagiq_user", {});
          userId = userInfo?.id || "";
        }

        const userAddresses = await addressesService.getUserAddressesByType(
          "FACTURACION",
          userId
        );

        // Solo mostrar la última dirección de facturación (la más reciente)
        const latestOnly = userAddresses.length > 0 ? [userAddresses[0]] : [];
        setAddresses(latestOnly);

        // Auto-seleccionar la última dirección
        if (latestOnly.length > 0) {
          setSelectedAddressId(latestOnly[0].id);
          handleAddressSelect(latestOnly[0]);
        }
      } catch (error) {
        console.error("Error loading addresses:", error);
      } finally {
        setIsLoadingAddresses(false);
      }
    };

    loadAddresses();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user]);

  // Cargar datos del usuario autenticado o de localStorage
  useEffect(() => {
    const savedData = localStorage.getItem("checkout-billing-data");

    if (savedData) {
      // Si hay datos guardados en localStorage, usarlos
      try {
        const parsed = JSON.parse(savedData);
        setBillingData({
          ...parsed,
          // Asegurar que tipoDocumento siempre tenga un valor por defecto
          tipoDocumento: parsed.tipoDocumento || "C.C.",
        });
        setBillingType(parsed.type || "natural");

        // Si hay una dirección guardada, intentar seleccionarla
        if (parsed.direccion?.id) {
          setSelectedAddressId(parsed.direccion.id);
        }
      } catch (error) {
        console.error("Error parsing billing data:", error);
      }
    } else {
      // En modo kiosk, priorizar datos del cliente kiosk sobre la cuenta de la tienda
      const kioskClient = (() => {
        try {
          const kc = localStorage.getItem("kiosk_client_id");
          return kc ? JSON.parse(kc) : null;
        } catch { return null; }
      })();

      if (kioskClient) {
        // Auto-completar con datos del cliente kiosk
        setBillingData({
          type: "natural",
          nombre: `${kioskClient.nombre || ""} ${kioskClient.apellido || ""}`.trim(),
          documento: kioskClient.cedula || kioskClient.numero_documento || "",
          tipoDocumento: normalizeDocType(kioskClient.tipo_documento),
          email: kioskClient.email || "",
          telefono: kioskClient.celular || kioskClient.telefono || "",
          direccion: null,
        });
      } else {
        // Intentar obtener usuario desde localStorage si user del contexto es null (caso invitado)
        const userToCheck = user || (() => {
          try {
            const userInfo = localStorage.getItem("imagiq_user");
            return userInfo ? JSON.parse(userInfo) : null;
          } catch {
            return null;
          }
        })();

        if (userToCheck) {
          // Si no hay datos guardados, auto-completar con datos del usuario (o invitado)
          setBillingData({
            type: "natural",
            nombre: `${userToCheck.nombre || ""} ${userToCheck.apellido || ""}`.trim(),
            documento: userToCheck.numero_documento || "",
            tipoDocumento: userToCheck.tipo_documento || "C.C.",
            email: userToCheck.email || "",
            telefono: userToCheck.telefono || userToCheck.celular || "",
            direccion: null,
          });
        }
      }
    }
  }, [user]);

  // Cargar dirección de envío si el usuario marca el checkbox
  useEffect(() => {
    if (useShippingData) {
      let shippingAddress = localStorage.getItem("checkout-address");
      // Fallback: si no hay checkout-address, intentar con imagiq_default_address (para invitados)
      if (!shippingAddress) {
        shippingAddress = localStorage.getItem("imagiq_default_address");
      }

      if (shippingAddress) {
        try {
          const parsed = JSON.parse(shippingAddress);
          
          setBillingData((prev) => {
            // En modo kiosk, priorizar datos del cliente kiosk
            let userData = null;
            try {
              const kioskStr = localStorage.getItem("kiosk_client_id");
              if (kioskStr) {
                const kc = JSON.parse(kioskStr);
                userData = {
                  nombre: kc.nombre || "",
                  apellido: kc.apellido || "",
                  numero_documento: kc.cedula || kc.numero_documento || "",
                  tipo_documento: normalizeDocType(kc.tipo_documento),
                  email: kc.email || "",
                  telefono: kc.celular || kc.telefono || "",
                };
              } else {
                const userStr = localStorage.getItem("imagiq_user");
                if (userStr) userData = JSON.parse(userStr);
              }
            } catch (e) { console.error(e); }

            return {
              ...prev,
              direccion: parsed,
              // Autocompletar solo si están vacíos
              nombre: prev.nombre || (userData ? `${userData.nombre || ""} ${userData.apellido || ""}`.trim() : prev.nombre),
              documento: prev.documento || (userData?.numero_documento || prev.documento),
              tipoDocumento: prev.tipoDocumento || (userData?.tipo_documento || prev.tipoDocumento),
              email: prev.email || (userData?.email || parsed.email || prev.email),
              telefono: prev.telefono || (userData?.telefono || userData?.celular || prev.telefono),
            };
          });
          
          // Limpiar error de dirección si existe
          setErrors(prev => {
            const newErrors = { ...prev };
            delete newErrors.direccion;
            return newErrors;
          });
        } catch (error) {
          console.error("Error parsing shipping address:", error);
        }
      }
    }
  }, [useShippingData]);

  // Load Trade-In data from localStorage (nuevo formato de mapa)
  useEffect(() => {
    const storedTradeIn = localStorage.getItem("imagiq_trade_in");
    if (storedTradeIn) {
      try {
        const parsed = JSON.parse(storedTradeIn);
        // Verificar si es formato nuevo (mapa con SKUs como keys) o antiguo (objeto único)
        if (typeof parsed === 'object' && !parsed.deviceName) {
          // Formato nuevo: { "SKU1": { completed, deviceName, value }, ... }
          setTradeInDataMap(parsed);
        } else if (parsed.completed) {
          // Formato antiguo: { completed, deviceName, value } - convertir a mapa
          setTradeInDataMap({ "legacy_tradein": parsed });
        }
      } catch (error) {
        console.error("Error parsing Trade-In data:", error);
      }
    }
  }, []);

  // Handle Trade-In removal (ahora soporta eliminar por SKU)
  const handleRemoveTradeIn = (skuToRemove?: string) => {
    if (skuToRemove) {
      // Eliminar solo el SKU específico
      const updatedMap = { ...tradeInDataMap };
      delete updatedMap[skuToRemove];
      setTradeInDataMap(updatedMap);

      // Actualizar localStorage
      if (Object.keys(updatedMap).length > 0) {
        localStorage.setItem("imagiq_trade_in", JSON.stringify(updatedMap));
      } else {
        localStorage.removeItem("imagiq_trade_in");
      }
    } else {
      // Eliminar todos los trade-ins
      localStorage.removeItem("imagiq_trade_in");
      setTradeInDataMap({});
    }

    // Si se elimina el trade-in y el método está en "tienda", cambiar a "domicilio"
    if (typeof globalThis.window !== "undefined") {
      const currentMethod = globalThis.window.localStorage.getItem("checkout-delivery-method");
      if (currentMethod === "tienda") {
        globalThis.window.localStorage.setItem("checkout-delivery-method", "domicilio");
        globalThis.window.dispatchEvent(
          new CustomEvent("delivery-method-changed", { detail: { method: "domicilio" } })
        );
        globalThis.window.dispatchEvent(new Event("storage"));
      }
    }
  };

  const handleTypeChange = (type: BillingType) => {
    setBillingType(type);
    setBillingData((prev) => ({
      ...prev,
      type,
    }));
  };

  const handleInputChange = (field: keyof BillingData, value: string) => {
    setBillingData((prev) => ({
      ...prev,
      [field]: value,
    }));
    // Limpiar error del campo cuando el usuario empieza a escribir
    if (errors[field]) {
      setErrors((prev) => {
        const newErrors = { ...prev };
        delete newErrors[field];
        return newErrors;
      });
    }
  };

  const handleOpenAddAddressModal = () => {
    setIsAddAddressModalOpen(true);
  };

  const handleCloseAddAddressModal = () => {
    setIsAddAddressModalOpen(false);
  };

  const handleAddressAdded = async (newAddress: Address) => {
    // Solo mostrar la dirección recién creada (la más reciente)
    setAddresses([newAddress]);
    handleAddressSelect(newAddress);
    handleCloseAddAddressModal();
  };

  // Abrir modal de confirmación para eliminar
  const handleDeleteClick = (addr: Address, e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();

    // No permitir eliminar direcciones predeterminadas
    if (addr.esPredeterminada) {
      toast.error("No puedes eliminar una dirección predeterminada");
      return;
    }

    setAddressToDelete(addr);
    setShowDeleteConfirm(true);
  };

  // Confirmar eliminación
  const handleConfirmDelete = async () => {
    if (!addressToDelete) return;

    setDeletingAddressId(addressToDelete.id);

    try {
      await addressesService.deleteAddress(addressToDelete.id);
      toast.success("Dirección eliminada correctamente");

      // Recargar direcciones
      const userInfo = safeGetLocalStorage<{ id?: string }>("imagiq_user", {});
      const userAddresses = await addressesService.getUserAddressesByType(
        "FACTURACION",
        userInfo?.id || ""
      );
      setAddresses(userAddresses);

      // Si la dirección eliminada era la seleccionada, limpiar selección
      if (selectedAddressId === addressToDelete.id) {
        setSelectedAddressId(null);
        setBillingData((prev) => ({
          ...prev,
          direccion: null,
        }));
      }

      setShowDeleteConfirm(false);
      setAddressToDelete(null);
    } catch (error) {
      console.error("Error eliminando dirección:", error);
      toast.error("Error al eliminar la dirección");
    } finally {
      setDeletingAddressId(null);
    }
  };

  // Cancelar eliminación
  const handleCancelDelete = () => {
    setShowDeleteConfirm(false);
    setAddressToDelete(null);
  };

  const validateForm = (): boolean => {
    const newErrors: Record<string, string> = {};

    // Validaciones comunes
    if (!billingData.nombre.trim()) {
      newErrors.nombre = "El nombre es requerido";
    }
    if (!billingData.documento.trim()) {
      newErrors.documento = "El documento es requerido";
    }
    if (!billingData.email.trim()) {
      newErrors.email = "El email es requerido";
    } else if (!/\S+@\S+\.\S+/.test(billingData.email)) {
      newErrors.email = "El email no es válido";
    }
    if (!billingData.tipoDocumento?.trim()) {
      newErrors.tipoDocumento = "El tipo de documento es requerido";
    }
    if (!billingData.telefono.trim()) {
      newErrors.telefono = "El teléfono es requerido";
    }
    if (!billingData.direccion) {
      newErrors.direccion = "La dirección es requerida";
    }

    // Validaciones específicas de persona jurídica
    if (billingType === "juridica") {
      if (!billingData.razonSocial?.trim()) {
        newErrors.razonSocial = "La razón social es requerida";
      }
      if (!billingData.nit?.trim()) {
        newErrors.nit = "El NIT es requerido";
      }
    }

    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const handleContinue = () => {
    setIsProcessing(true);

    try {
      // Validar Trade-In antes de continuar
      const validation = validateTradeInProducts(products);
      if (!validation.isValid) {
        alert(getTradeInValidationMessage(validation));
        setIsProcessing(false);
        return;
      }

      // Siempre validar el formulario para mostrar errores
      if (!validateForm()) {
        // Mostrar toast de error
        toast.error("Por favor completa todos los campos requeridos");

        // Hacer scroll al primer error
        const firstErrorElement = document.querySelector('.border-red-500');
        if (firstErrorElement) {
          firstErrorElement.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
        setIsProcessing(false);
        return;
      }

      // Preparar datos a guardar; si se usa la dirección de envío, asegurar que guardamos su `id`
      let billingToSave: BillingData = { ...billingData };
      if (useShippingData) {
        let shippingAddressStr = localStorage.getItem("checkout-address");
        if (!shippingAddressStr) {
          shippingAddressStr = localStorage.getItem("imagiq_default_address");
        }
        
        if (shippingAddressStr) {
          try {
            const parsed = JSON.parse(shippingAddressStr);
            if (parsed && typeof parsed === "object") {
              // Asegurar que la dirección en el billing incluye el id del checkout-address
              billingToSave = {
                ...billingToSave,
                direccion: {
                  ...(billingToSave.direccion || {}),
                  ...parsed,
                },
              };
            }
          } catch (err) {
            // Si falla el parseo, no interrumpir el guardado; seguimos con billingData actual
            console.error("Error parsing checkout-address for billing id:", err);
          }
        }
      }

      // Guardar datos en localStorage
      localStorage.setItem(
        "checkout-billing-data",
        JSON.stringify(billingToSave)
      );

      if (onContinue) {
        onContinue();
      }

      // Reset processing state in case navigation doesn't unmount component immediately
      setIsProcessing(false);
    } catch (error) {
      console.error("Error en handleContinue:", error);
      toast.error("Ocurrió un error. Por favor intenta de nuevo");
      setIsProcessing(false);
    }
  };


  // Ordenador para direcciones: predeterminadas primero
  const sortAddressesByDefault = (a: Address, b: Address) => {
    if (a.esPredeterminada === b.esPredeterminada) return 0;
    return a.esPredeterminada ? -1 : 1;
  };

  // Renderiza la sección de direcciones (evita ternarios anidados en JSX)
  const renderAddressSection = () => {
    if (useShippingData) {
      return (
        billingData.direccion && (
          <div className="p-4 bg-gray-50 rounded-lg border border-gray-200">
            <p className="text-sm font-medium text-gray-700">
              {billingData.direccion.linea_uno}
            </p>
            {billingData.direccion.ciudad && (
              <p className="text-sm text-gray-600 mt-1">
                {billingData.direccion.ciudad}
              </p>
            )}
          </div>
        )
      );
    }

    if (isLoadingAddresses) {
      return (
        <div className="animate-pulse space-y-3">
          <div className="h-16 bg-gray-200 rounded-lg"></div>
          <div className="h-16 bg-gray-200 rounded-lg"></div>
        </div>
      );
    }

    if (addresses.length > 0) {
      return (
        <div className="space-y-3">
          <div className="flex items-center justify-between mb-2">
            <p className="text-sm text-gray-600">
              Selecciona una dirección de facturación
            </p>
            <button
              type="button"
              onClick={handleOpenAddAddressModal}
              className="text-sm text-blue-600 hover:text-blue-700 font-medium flex items-center gap-1"
            >
              <Plus className="w-4 h-4" />
              Nueva dirección
            </button>
          </div>

          {addresses.toSorted(sortAddressesByDefault).map((address) => (
            <div
              key={address.id}
              role="button"
              tabIndex={0}
              onClick={() => handleAddressSelect(address)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  handleAddressSelect(address);
                }
              }}
              className={`w-full text-left p-4 rounded-lg border-2 transition-all cursor-pointer ${
                selectedAddressId === address.id
                  ? "border-black bg-gray-50"
                  : "border-gray-200 hover:border-gray-300 bg-white"
              }`}
            >
              <div className="flex items-start gap-3">
                <div
                  className={`flex-shrink-0 w-5 h-5 rounded-full border-2 flex items-center justify-center transition-all mt-0.5 ${
                    selectedAddressId === address.id
                      ? "border-black bg-black"
                      : "border-gray-300 bg-white"
                  }`}
                >
                  {selectedAddressId === address.id && (
                    <Check className="w-3 h-3 text-white" />
                  )}
                </div>

                <div className="flex-shrink-0">
                  <MapPin className="w-5 h-5 text-gray-400" />
                </div>

                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1">
                    <p className="font-semibold text-gray-900">
                      {address.nombreDireccion}
                    </p>
                    {address.esPredeterminada && (
                      <span className="text-xs bg-green-100 text-green-700 px-2 py-0.5 rounded-full font-semibold">
                        Predeterminada
                      </span>
                    )}
                  </div>
                  <p className="text-sm text-gray-600">
                    {address.direccionFormateada}
                  </p>
                  {address.ciudad && (
                    <p className="text-xs text-gray-500 mt-1">
                      {address.ciudad}
                    </p>
                  )}
                </div>

                {/* Botón eliminar - solo si no es predeterminada */}
                {!address.esPredeterminada && (
                  <button
                    type="button"
                    onClick={(e) => handleDeleteClick(address, e)}
                    disabled={deletingAddressId === address.id}
                    className="flex-shrink-0 p-1.5 text-gray-400 hover:text-red-500 hover:bg-red-50 rounded-md transition-colors disabled:opacity-50"
                    title="Eliminar dirección"
                  >
                    {deletingAddressId === address.id ? (
                      <div className="w-4 h-4 border-2 border-gray-300 border-t-red-500 rounded-full animate-spin" />
                    ) : (
                      <Trash2 className="w-4 h-4" />
                    )}
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      );
    }

    return (
      <div className="bg-gray-50 border-2 border-dashed border-gray-300 rounded-xl p-8 text-center">
        <MapPin className="w-12 h-12 text-gray-400 mx-auto mb-3" />
        <p className="text-gray-600 text-sm mb-4">
          No tienes direcciones de facturación guardadas
        </p>
        <button
          type="button"
          onClick={handleOpenAddAddressModal}
          className="inline-flex items-center gap-2 px-5 py-2.5 bg-black text-white rounded-lg hover:bg-gray-800 transition-colors font-semibold text-sm"
        >
          <Plus className="w-4 h-4" />
          Agregar dirección
        </button>
      </div>
    );
  };

  // Mostrar loading mientras el carrito se carga
  if (isCartLoading) {
    return (
      <div className="min-h-screen w-full flex items-center justify-center">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-gray-900 mx-auto mb-4"></div>
          <p className="text-gray-600">Cargando...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen w-full pb-40 md:pb-0">
      <div className="w-full max-w-7xl mx-auto px-4 py-6">
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Formulario de facturación */}
          <div className="lg:col-span-2 space-y-4 lg:min-h-[70vh]">
            <div className="bg-white rounded-lg p-6 border border-gray-200">
              {/* Header con título y checkbox Persona Jurídica */}
              <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4 mb-6">
                <h2 className="text-[22px] font-bold">
                  Datos de facturación
                </h2>

                {/* Checkbox Compra empresa */}
                <label className="flex items-center gap-3 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={billingType === "juridica"}
                    onChange={(e) => handleTypeChange(e.target.checked ? "juridica" : "natural")}
                    className="w-5 h-5 accent-black"
                  />
                  <span className="text-base font-semibold text-gray-700">
                    Compra empresa
                  </span>
                </label>
              </div>

              {/* Checkbox: Usar mismos datos de envío */}
              <div className="mb-6">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={useShippingData}
                    onChange={(e) => setUseShippingData(e.target.checked)}
                    className="w-4 h-4 accent-black"
                  />
                  <span className="text-sm text-gray-700">
                    Usar los mismos datos de envío
                  </span>
                </label>
              </div>

              {/* Formulario según tipo de persona */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {billingType === "juridica" && (
                  <>
                    {/* Razón Social */}
                    <div>
                      <label
                        htmlFor="razonSocial"
                        className="block text-sm font-medium text-gray-700 mb-2"
                      >
                        Razón Social <span className="text-red-500">*</span>
                      </label>
                      <input
                        id="razonSocial"
                        type="text"
                        value={billingData.razonSocial || ""}
                        onChange={(e) =>
                          handleInputChange("razonSocial", e.target.value)
                        }
                        className={`w-full px-4 py-2 border rounded-lg focus:outline-none focus:ring-2 focus:ring-black ${
                          errors.razonSocial
                            ? "border-red-500"
                            : "border-gray-300"
                        }`}
                        placeholder="Empresa S.A.S."
                      />
                      {errors.razonSocial && (
                        <p className="text-red-500 text-xs mt-1">
                          {errors.razonSocial}
                        </p>
                      )}
                    </div>

                    {/* NIT */}
                    <div>
                      <label
                        htmlFor="nit"
                        className="block text-sm font-medium text-gray-700 mb-2"
                      >
                        NIT <span className="text-red-500">*</span>
                      </label>
                      <input
                        id="nit"
                        type="text"
                        inputMode="numeric"
                        value={billingData.nit || ""}
                        // Solo digitos: la pasarela no espera el digito de
                        // verificacion ni separadores, y dejarlos escribir
                        // obligaba a limpiarlos despues con el riesgo de
                        // adivinar mal cual sobra.
                        onChange={(e) =>
                          handleInputChange(
                            "nit",
                            e.target.value.replace(/\D/g, "")
                          )
                        }
                        className={`w-full px-4 py-2 border rounded-lg focus:outline-none focus:ring-2 focus:ring-black ${
                          errors.nit ? "border-red-500" : "border-gray-300"
                        }`}
                        placeholder="900123456"
                      />
                      {errors.nit && (
                        <p className="text-red-500 text-xs mt-1">
                          {errors.nit}
                        </p>
                      )}
                    </div>
                  </>
                )}

                {/* Nombre (o nombre del contacto para jurídica) */}
                <div className="md:col-span-2">
                  <label
                    htmlFor="nombre"
                    className="block text-sm font-medium text-gray-700 mb-2"
                  >
                    {billingType === "juridica"
                      ? "Nombre de contacto"
                      : "Nombre completo"}{" "}
                    <span className="text-red-500">*</span>
                  </label>
                  <input
                    id="nombre"
                    type="text"
                    value={billingData.nombre}
                    onChange={(e) =>
                      handleInputChange("nombre", e.target.value)
                    }
                    className={`w-full px-4 py-2 border rounded-lg focus:outline-none focus:ring-2 focus:ring-black ${
                      errors.nombre ? "border-red-500" : "border-gray-300"
                    }`}
                    placeholder="Juan Pérez"
                  />
                  {errors.nombre && (
                    <p className="text-red-500 text-xs mt-1">{errors.nombre}</p>
                  )}
                </div>

                {/* Tipo de documento */}
                <div className="md:col-span-1">
                  <label
                    htmlFor="tipoDocumento"
                    className="block text-sm font-medium text-gray-700 mb-2"
                  >
                    Tipo de documento <span className="text-red-500">*</span>
                  </label>
                  <select
                    id="tipoDocumento"
                    name="tipoDocumento"
                    value={billingData.tipoDocumento || ""}
                    onChange={(e) =>
                      handleInputChange(
                        "tipoDocumento" as keyof BillingData,
                        e.target.value
                      )
                    }
                    aria-invalid={Boolean(errors.tipoDocumento)}
                    required
                    className={`w-full px-4 py-2 border rounded-lg focus:outline-none focus:ring-2 focus:ring-black ${
                      errors.tipoDocumento
                        ? "border-red-500"
                        : "border-gray-300"
                    }`}
                  >
                    <option value="">Selecciona el tipo de documento</option>
                    <option value="C.C.">C.C.</option>
                    <option value="C.E.">C.E.</option>
                    <option value="NIT">NIT</option>
                    <option value="PASAPORTE">Pasaporte</option>
                  </select>
                  {errors.tipoDocumento && (
                    <p className="text-red-500 text-xs mt-1">
                      {errors.tipoDocumento}
                    </p>
                  )}
                </div>

                {/* Documento */}
                <div className="md:col-span-1">
                  <label
                    htmlFor="documento"
                    className="block text-sm font-medium text-gray-700 mb-2"
                  >
                    {billingType === "juridica"
                      ? "Cédula del contacto"
                      : "Documento de identidad"}{" "}
                    <span className="text-red-500">*</span>
                  </label>
                  <input
                    id="documento"
                    name="documento"
                    type="text"
                    value={billingData.documento}
                    onChange={(e) =>
                      handleInputChange("documento", e.target.value)
                    }
                    aria-invalid={Boolean(errors.documento)}
                    required
                    className={`w-full px-4 py-2 border rounded-lg focus:outline-none focus:ring-2 focus:ring-black ${
                      errors.documento ? "border-red-500" : "border-gray-300"
                    }`}
                    placeholder="1234567890"
                  />
                  {errors.documento && (
                    <p className="text-red-500 text-xs mt-1">
                      {errors.documento}
                    </p>
                  )}
                </div>

                {/* Email */}
                <div>
                  <label
                    htmlFor="email"
                    className="block text-sm font-medium text-gray-700 mb-2"
                  >
                    Email <span className="text-red-500">*</span>
                  </label>
                  <input
                    id="email"
                    type="email"
                    value={billingData.email}
                    onChange={(e) => handleInputChange("email", e.target.value)}
                    className={`w-full px-4 py-2 border rounded-lg focus:outline-none focus:ring-2 focus:ring-black ${
                      errors.email ? "border-red-500" : "border-gray-300"
                    }`}
                    placeholder="correo@ejemplo.com"
                  />
                  {errors.email && (
                    <p className="text-red-500 text-xs mt-1">{errors.email}</p>
                  )}
                </div>

                {/* Teléfono */}
                <div>
                  <label
                    htmlFor="telefono"
                    className="block text-sm font-medium text-gray-700 mb-2"
                  >
                    Teléfono <span className="text-red-500">*</span>
                  </label>
                  <input
                    id="telefono"
                    type="tel"
                    value={billingData.telefono}
                    onChange={(e) =>
                      handleInputChange("telefono", e.target.value)
                    }
                    className={`w-full px-4 py-2 border rounded-lg focus:outline-none focus:ring-2 focus:ring-black ${
                      errors.telefono ? "border-red-500" : "border-gray-300"
                    }`}
                    placeholder="3001234567"
                  />
                  {errors.telefono && (
                    <p className="text-red-500 text-xs mt-1">
                      {errors.telefono}
                    </p>
                  )}
                </div>
              </div>

              {/* Dirección de facturación */}
              <div className="mt-6">
                <h3 className="text-lg font-semibold text-gray-900 mb-4">
                  Dirección de facturación
                </h3>

                <Modal
                  isOpen={isAddAddressModalOpen}
                  onClose={handleCloseAddAddressModal}
                  size="lg"
                  showCloseButton={false}
                >
                  <AddNewAddressForm
                    onAddressAdded={handleAddressAdded}
                    onCancel={handleCloseAddAddressModal}
                    withContainer={false}
                    skipSetDefault={true}
                    billingOnly={true}
                  />
                </Modal>

                {renderAddressSection()}

                {errors.direccion && (
                  <p className="text-red-500 text-xs mt-2">
                    {errors.direccion}
                  </p>
                )}
              </div>
            </div>
          </div>

          {/* Resumen de compra y Trade-In - Hidden en mobile */}
          <aside className="hidden md:block lg:col-span-1 space-y-4 self-start sticky top-40">
            <Step4OrderSummary
              onFinishPayment={handleContinue}
              onBack={onBack}
              buttonText="Continuar"
              buttonVariant="green"
              disabled={!isFormValid || !tradeInValidation.isValid || isProcessing}
              isProcessing={isProcessing}
              isSticky={true}
              deliveryMethod={
                typeof window !== "undefined"
                  ? (() => {
                      const method = localStorage.getItem("checkout-delivery-method");
                      if (method === "tienda") return "pickup";
                      if (method === "domicilio") return "delivery";
                      if (method === "delivery" || method === "pickup") return method;
                      return undefined;
                    })()
                  : undefined
              }
            />

            {/* Banner de Trade-In - Mostrar para cada producto con trade-in */}
            {Object.entries(tradeInDataMap).map(([sku, tradeIn]) => {
              if (!tradeIn?.completed) return null;
              return (
                <TradeInCompletedSummary
                  key={sku}
                  deviceName={tradeIn.deviceName}
                  tradeInValue={tradeIn.value}
                  onEdit={() => handleRemoveTradeIn(sku)}
                  validationError={!tradeInValidation.isValid ? getTradeInValidationMessage(tradeInValidation) : undefined}
                />
              );
            })}
          </aside>
        </div>
      </div>

      {/* Sticky Bottom Bar - Solo Mobile */}
      <div className="md:hidden fixed bottom-0 left-0 right-0 bg-white border-t border-gray-200 shadow-lg z-50">
        <div className="p-4 pb-8 flex items-center justify-between gap-4">
          {/* Izquierda: Total y descuentos */}
          <div className="flex-1 min-w-0">
            <p className="text-sm text-gray-500">
              Total ({products.reduce((acc, p) => acc + p.quantity, 0)}{" "}
              productos)
            </p>
            <p className="text-2xl font-bold text-gray-900">
              $ {Number(products.reduce((acc, p) => acc + p.price * p.quantity, 0)).toLocaleString()}
            </p>
            {/* Mostrar descuento si existe */}
            {productSavings > 0 && (
              <p className="text-sm text-green-600 font-medium">
                -$ {Number(productSavings).toLocaleString()} desc.
              </p>
            )}
          </div>

          {/* Derecha: Botón continuar - destacado con sombra y glow */}
          <button
            className={`flex-shrink-0 font-bold py-4 px-6 rounded-xl text-lg transition-all duration-200 text-white border-2 ${
              !isFormValid || !tradeInValidation.isValid || isProcessing
                ? "bg-gray-400 border-gray-300 cursor-not-allowed"
                : "bg-green-600 border-green-500 hover:bg-green-700 hover:border-green-600 cursor-pointer shadow-lg shadow-green-500/40 hover:shadow-xl hover:shadow-green-500/50"
            }`}
            onClick={handleContinue}
            disabled={!isFormValid || !tradeInValidation.isValid || isProcessing}
          >
            {isProcessing ? "Procesando..." : "Continuar"}
          </button>
        </div>
      </div>

      {/* Modal de confirmación para eliminar dirección */}
      <ConfirmModal
        isOpen={showDeleteConfirm}
        onClose={handleCancelDelete}
        onConfirm={handleConfirmDelete}
        title="Eliminar dirección"
        message={`¿Estás seguro de eliminar la dirección "${addressToDelete?.nombreDireccion || addressToDelete?.direccionFormateada || ''}"? Esta acción no se puede deshacer.`}
        confirmText="Eliminar"
        cancelText="Cancelar"
        variant="danger"
        isLoading={deletingAddressId !== null}
      />
    </div>
  );
}
