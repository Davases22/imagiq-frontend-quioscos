"use client";
import React, { useState, useEffect, useRef, useMemo } from "react";
import { useRouter } from "next/navigation";
import Step4OrderSummary from "./components/Step4OrderSummary";
import TradeInCompletedSummary from "@/app/productos/dispositivos-moviles/detalles-producto/estreno-y-entrego/TradeInCompletedSummary";
import {
  CreditCard,
  MapPin,
  FileText,
  Truck,
  Store,
  Edit2,
  User as UserIcon,
  Package,
  RefreshCw,
  LogOut,
} from "lucide-react";
import Image from "next/image";
import { useAuthContext } from "@/features/auth/context";
import { profileService } from "@/services/profile.service";
import { toast } from "sonner";
import { DBCard, DecryptedCardData } from "@/features/profile/types";
import { encryptionService } from "@/lib/encryption";
import CardBrandLogo from "@/components/ui/CardBrandLogo";
import { payWithAddi, payWithCard, payWithPse, fetchBanks, kioskPayWithPse, kioskPayWithAddi, kioskCreateDatafonoOrder, kioskConfirmDatafono, kioskProcessDatafono, kioskProcessDatafonoV2, getPostHogIds } from "./utils";
import { useCart } from "@/hooks/useCart";
import { useCardsCache } from "./hooks/useCardsCache";
import { useDelivery } from "./hooks/useDelivery";
import {
  validateTradeInProducts,
  getTradeInValidationMessage,
} from "./utils/validateTradeIn";
import { CheckZeroInterestResponse, BeneficiosDTO, DetalleDispositivoRetoma } from "./types";
import { apiPost } from "@/lib/api-client";
import { safeGetLocalStorage } from "@/lib/localStorage";
import { addressesService } from "@/services/addresses.service";
import { productEndpoints, deliveryEndpoints, tradeInEndpoints } from "@/lib/api";
import useSecureStorage from "@/hooks/useSecureStorage";
import { User } from "@/types/user";
import RegisterGuestPasswordModal from "./components/RegisterGuestPasswordModal";
import { connectKioskSocket, disconnectKioskSocket } from "@/lib/kiosk-socket";

declare global {
  interface Window {
    validate3ds: (data: unknown) => void;
  }
}

interface Step7Props {
  readonly onBack?: () => void;
}

interface StoreValidationResponse {
  codBodega?: string;
  nearest?: {
    codBodega?: string;
  };
}

type StoreValidationData = StoreValidationResponse | StoreValidationResponse[];

interface CardData {
  cardNumber: string;
  cardHolder: string;
  cardExpYear: string;
  cardExpMonth: string;
  cardCvc: string;
  brand?: string;
  cardType?: string;
  bank?: string;
}

interface PaymentData {
  method: string;
  cardData?: CardData;
  savedCard?: DBCard;
  bank?: string;
  bankName?: string;
  installments?: number;
}

interface ShippingData {
  type: "delivery" | "pickup";
  address?: string;
  city?: string;
  store?: {
    name: string;
    address?: string;
    city?: string;
    schedule?: string;
  };
}

interface ShippingVerification {
  envio_imagiq: boolean;
  todos_productos_im_it: boolean;
  en_zona_cobertura: boolean;
  todos_productos_solo_im?: boolean;
  productos_no_im_tienen_remota?: boolean;
}

interface BillingData {
  type: "natural" | "juridica";
  nombre: string;
  documento: string;
  email: string;
  telefono: string;
  direccion: {
    id: string;
    codigo_dane: string;
    pais: string;
    usuario_id: string;
    linea_uno: string;
    ciudad: string;
  };
  // Campos de persona jurídica
  razonSocial?: string;
  nit?: string;
  nombreRepresentante?: string;
  tipoDocumento: string;
}

export default function Step7({ onBack }: Step7Props) {
  const router = useRouter();
  const authContext = useAuthContext();
  const [isProcessing, setIsProcessing] = useState(false);

  // Ref para rastrear peticiones fallidas a getCandidateStores (evita reintentos)
  const failedCandidateStoresRef = React.useRef<string | null>(null);

  // Estados para datos de resumen
  const [paymentData, setPaymentData] = useState<PaymentData | null>(null);
  const [shippingData, setShippingData] = useState<ShippingData | null>(null);
  const [billingData, setBillingData] = useState<BillingData | null>(null);
  const [recipientData, setRecipientData] = useState<{
    receivedByClient: boolean;
    firstName?: string;
    lastName?: string;
    email?: string;
    phone?: string;
  } | null>(null);
  const [zeroInterestData, setZeroInterestData] =
    useState<CheckZeroInterestResponse | null>(null);
  const [shippingVerification, setShippingVerification] =
    useState<ShippingVerification | null>(null);
  const { products, calculations, clearCart } = useCart();

  // Calcular ahorro total por descuentos de productos
  const productSavings = useMemo(() => {
    return products.reduce((total, product) => {
      if (product.originalPrice && product.originalPrice > product.price) {
        const saving = (product.originalPrice - product.price) * product.quantity;
        return total + saving;
      }
      return total;
    }, 0);
  }, [products]);

  // Kiosk payment link sent state - restore from localStorage on mount
  const [kioskPaymentLinkSent, setKioskPaymentLinkSent] = useState<{
    email: string;
    orderId?: string;
    serialId?: string;
    whatsappSent?: boolean;
    clientData?: Record<string, any>;
    method?: string;
    savedAt?: number;
  } | null>(() => {
    if (typeof window === 'undefined') return null;
    try {
      const cached = localStorage.getItem('kiosk_payment_link_sent');
      if (!cached) return null;
      const parsed = JSON.parse(cached);
      if (!parsed?.orderId) return null;

      // Este flag SOLO aplica a links de pago (PSE/Addi) de la venta EN CURSO.
      // Antes se rehidrataba sin validar nada, así que un link no completado dejaba
      // el botón "Reenviar link" pegado en ventas posteriores —incluso con datáfono—
      // durante meses (caso Ses Palmira: links PSE de abril reaparecieron el 3-ago).
      // Ante cualquier duda se descarta: perder el botón de reenvío es inocuo
      // (se puede generar una orden nueva); usarlo con otra venta no lo es.
      const discard = () => {
        localStorage.removeItem('kiosk_payment_link_sent');
        return null;
      };

      // 1. Entradas viejas (previas a este fix) no traen `method` -> descartar.
      if (!parsed.method) return discard();

      // 2. El método de pago actual debe ser el mismo con el que se envió el link.
      const currentMethod = localStorage.getItem('checkout-payment-method');
      if (currentMethod && parsed.method !== currentMethod) return discard();

      // 3. Caducidad: un link vigente pertenece a la venta del momento, no a otro día.
      const MAX_AGE_MS = 12 * 60 * 60 * 1000; // 12 h (el JWT del kiosco dura 24 h)
      if (!parsed.savedAt || Date.now() - parsed.savedAt > MAX_AGE_MS) return discard();

      // 4. Debe ser el MISMO cliente. Solo descarta con evidencia de discrepancia:
      // si falta alguno de los dos correos, no se asume nada.
      try {
        const kioskClientRaw = localStorage.getItem('kiosk_client_id');
        const currentEmail = kioskClientRaw ? JSON.parse(kioskClientRaw)?.email : null;
        const flagEmail = parsed.clientData?.email || parsed.email;
        if (
          currentEmail &&
          flagEmail &&
          String(currentEmail).toLowerCase() !== String(flagEmail).toLowerCase()
        ) {
          return discard();
        }
      } catch { /* si no se puede comparar, se conserva */ }

      return parsed;
    } catch { /* ignore */ }
    return null;
  });

  // Cleanup kiosk payment link cache when leaving Step7 (unmount)
  useEffect(() => {
    return () => {
      localStorage.removeItem('kiosk_payment_link_sent');
      localStorage.removeItem('pending_order_id');
    };
  }, []);

  // Datafono/Efectivo flow states
  const [datafonoOrderId, setDatafonoOrderId] = useState<string | null>(null);
  const [datafonoOrderCreated, setDatafonoOrderCreated] = useState(false);
  const [datafonoConfirmed, setDatafonoConfirmed] = useState(false);
  const [isConfirmingDatafono, setIsConfirmingDatafono] = useState(false);

  // Kiosk tarjeta/datafono flow states
  const [datafonoSerialId] = useState<string | null>(null);

  const [error, setError] = useState<string | string[] | null>(null);
  const [isResending, setIsResending] = useState(false);
  const [resendCooldown, setResendCooldown] = useState(0);

  // Cooldown timer for resend button
  useEffect(() => {
    if (resendCooldown <= 0) return;
    const timer = setTimeout(() => setResendCooldown(resendCooldown - 1), 1000);
    return () => clearTimeout(timer);
  }, [resendCooldown]);

  // WebSocket: escuchar orden aprobada en modo quiosco
  const [showOrderApprovedModal, setShowOrderApprovedModal] = useState(false);

  useEffect(() => {
    const orderId = kioskPaymentLinkSent?.orderId;
    if (!orderId) return;

    console.log(`🔌 [KioskSocket] Conectando WebSocket para escuchar estado de orden: ${orderId}`);
    const socket = connectKioskSocket();

    socket.on('connect', () => {
      console.log(`✅ [KioskSocket] WebSocket conectado (id: ${socket.id}), emitiendo watch_order para orderId: ${orderId}`);
    });

    socket.on('disconnect', (reason) => {
      console.warn(`⚠️ [KioskSocket] WebSocket desconectado. Razón: ${reason}, orderId: ${orderId}`);
    });

    socket.on('connect_error', (error) => {
      console.error(`❌ [KioskSocket] Error de conexión WebSocket:`, error.message, `orderId: ${orderId}`);
    });

    console.log(`📡 [KioskSocket] Emitiendo watch_order { orderId: ${orderId} }`);
    socket.emit('watch_order', { orderId });

    // Fallback robusto: re-emitir watch_order cada 5s. Al recibir watch_order el
    // gateway consulta el estado REAL de la orden y reproduce 'order_approved'
    // si ya está APPROVED (kiosk-realtime.gateway → kioskOrderStatus, genérico
    // para PSE/Addi/datáfono). Cubre el caso en que el push en tiempo real no
    // llegue: webhook que no alcanza el entorno (local), corte de red del
    // kiosco, o un remount posterior a la emisión original.
    const rewatch = setInterval(() => {
      if (socket.connected) {
        socket.emit('watch_order', { orderId });
      }
    }, 5000);

    const handler = (data: { orderId: string }) => {
      console.log(`🎉 [KioskSocket] Evento order_approved recibido:`, data);
      if (data.orderId === orderId) {
        console.log(`✅ [KioskSocket] Orden ${orderId} APROBADA! Mostrando modal.`);
        setShowOrderApprovedModal(true);
        clearInterval(rewatch);
      }
    };
    socket.on('order_approved', handler);

    console.log(`👂 [KioskSocket] Escuchando evento 'order_approved' para orderId: ${orderId}`);

    return () => {
      console.log(`🔌 [KioskSocket] Limpiando WebSocket para orderId: ${orderId}`);
      clearInterval(rewatch);
      socket.off('order_approved', handler);
      socket.off('connect');
      socket.off('disconnect');
      socket.off('connect_error');
      disconnectKioskSocket();
    };
  }, [kioskPaymentLinkSent?.orderId]);

  // Detectar modo kiosco para cambiar texto del botón
  const isKioskMode = typeof window !== 'undefined' && !!localStorage.getItem("kiosk_client_id");
  const [isLoadingShippingMethod, setIsLoadingShippingMethod] = useState(false);
  // NUEVO: Estado separado para skeleton (solo espera canPickUp) y botón (espera cálculo de envío)
  const [isLoadingCanPickUp, setIsLoadingCanPickUp] = useState(false);

  // Utilizar caché de tarjetas para optimizar carga
  const { loadSavedCards } = useCardsCache();
  const [isCalculatingShipping, setIsCalculatingShipping] = useState(false);
  // Estado para guardar el código de bodega de candidate-stores
  const [candidateWarehouseCode, setCandidateWarehouseCode] = useState<string | undefined>();
  // Ref para leer el valor actual de isCalculatingShipping en callbacks
  const isCalculatingShippingRef = React.useRef(false);

  // Actualizar ref cuando cambie el estado
  React.useEffect(() => {
    isCalculatingShippingRef.current = isCalculatingShipping;
  }, [isCalculatingShipping]);
  const [loggedUser] = useSecureStorage<User | null>(
    "imagiq_user",
    null
  );

  // CRÍTICO: Usar useDelivery en modo onlyReadCache para leer datos de Steps 1-4
  // Esto permite mostrar la información de tiendas candidatas en el debug panel
  const {
    stores,
    availableStoresWhenCanPickUpFalse,
    filteredStores,
    availableCities,
  } = useDelivery();

  // Estado para el modal de registro de contraseña
  const [showPasswordModal, setShowPasswordModal] = useState(false);
  const [pendingOrder, setPendingOrder] = useState(false); // Para saber si debemos proceder con la orden después del registro

  // CRÍTICO: Leer dirección desde localStorage normal, NO desde useSecureStorage
  // porque se guarda en localStorage.setItem("checkout-address") en Step3
  const [checkoutAddress, setCheckoutAddress] = useState<{
    "id": string,
    "usuario_id": string,
    "email": string,
    "linea_uno": string,
    "codigo_dane": string,
    "ciudad": string,
    "pais": string,
    "esPredeterminada": boolean
  } | null>(null);

  // Cargar dirección desde localStorage al montar el componente
  useEffect(() => {
    const loadAddress = async () => {
      try {
        const addressStr = localStorage.getItem('checkout-address');
        if (addressStr) {
          const parsed = JSON.parse(addressStr);
          setCheckoutAddress(parsed);
          return;
        }

        // Fallback para kiosk: si no hay checkout-address en localStorage,
        // intentar obtener la dirección predeterminada del cliente kiosk desde el API
        const kioskClientStr = localStorage.getItem('kiosk_client_id');
        if (kioskClientStr) {
          console.warn("⚠️ [Step7 - Init] No hay checkout-address en localStorage, intentando obtener desde API para kiosk...");
          try {
            const defaultAddress = await addressesService.getDefaultAddress("ENVIO");
            if (defaultAddress?.id) {
              const recoveredAddress = {
                id: defaultAddress.id,
                usuario_id: defaultAddress.usuarioId || "",
                email: "",
                linea_uno: defaultAddress.lineaUno || defaultAddress.direccionFormateada || "",
                codigo_dane: defaultAddress.codigo_dane || "",
                ciudad: defaultAddress.ciudad || "",
                pais: defaultAddress.pais || "Colombia",
                esPredeterminada: true,
              };
              localStorage.setItem('checkout-address', JSON.stringify(recoveredAddress));
              setCheckoutAddress(recoveredAddress);
              console.log("✅ [Step7 - Init] Dirección recuperada desde API para kiosk:", recoveredAddress.id);
              return;
            }
          } catch (apiErr) {
            console.error("❌ [Step7 - Init] Error al obtener dirección desde API:", apiErr);
          }
        }

        console.warn("⚠️ [Step7 - Init] No se encontró checkout-address en localStorage");
      } catch (error) {
        console.error("❌ [Step7 - Init] Error al cargar checkout-address:", error);
      }
    };
    loadAddress();
  }, []);

  // Store/Warehouse validation state
  const [isCentroDistribucion, setIsCentroDistribucion] = useState<boolean | null>(null);
  const [isLoadingStoreValidation, setIsLoadingStoreValidation] = useState(false);

  // 3DS Modal state - Not used anymore, kept for backward compatibility
  // const [show3DSModal, setShow3DSModal] = useState(false);
  // const [challengeData, setChallengeData] = useState<{
  //   acsURL: string;
  //   encodedCReq: string;
  //   threeDSServerTransID?: string;
  //   acsTransID?: string;
  // } | null>(null);
  // const [currentOrderId, setCurrentOrderId] = useState<string>("");

  // Trade-In state management - soporta múltiples productos
  const [tradeInDataMap, setTradeInDataMap] = useState<Record<string, {
    completed: boolean;
    deviceName: string; // Nombre del dispositivo que se entrega
    value: number;
    sku?: string; // SKU del producto que se compra
    name?: string; // Nombre del producto que se compra
    skuPostback?: string; // SKU Postback del producto que se compra
  }>>({});

  // Cargar datos de localStorage
  useEffect(() => {
    const loadPaymentData = async () => {
      // Cargar método de pago
      const paymentMethod = localStorage.getItem("checkout-payment-method");
      const savedCardId = localStorage.getItem("checkout-saved-card-id");
      const cardDataStr = localStorage.getItem("checkout-card-data");
      const selectedBank = localStorage.getItem("checkout-selected-bank");
      const installments = localStorage.getItem("checkout-installments");

      if (paymentMethod) {
        let cardData: CardData | undefined;
        let savedCard: DBCard | undefined;

        // Si usó una tarjeta guardada, cargar sus datos completos
        // Usar authContext o loggedUser (para usuarios sin sesión activa pero con cuenta creada en Step2)
        const userId = authContext.user?.id || loggedUser?.id;
        if (savedCardId && userId) {
          try {
            // USAR CACHÉ: En lugar de llamar a la API directamente, usar la caché compartida
            // Esto aprovecha los datos cargados en paso 4 si existen
            const decryptedCards = await loadSavedCards();

            savedCard = decryptedCards.find(
              (card) => String(card.id) === savedCardId
            );
          } catch (error) {
            console.error("Error loading saved card:", error);
          }
        }
        // Si hay datos de tarjeta nueva ingresados
        else if (cardDataStr) {
          try {
            cardData = JSON.parse(cardDataStr);
          } catch (error) {
            console.error("Error parsing card data:", error);
          }
        }

        // selectedBank can be a JSON string { code, name } or a plain code string
        let bankCode: string | undefined = undefined;
        let bankName: string | undefined = undefined;
        if (selectedBank) {
          try {
            const parsed = JSON.parse(selectedBank);
            if (parsed && typeof parsed === "object" && "code" in parsed) {
              bankCode = parsed.code || undefined;
              bankName = parsed.name || undefined;
            } else {
              bankCode = String(selectedBank);
            }
          } catch {
            bankCode = selectedBank;
          }
          // If we have a code but no name, try to resolve the name from the banks API
          if (bankCode && !bankName) {
            try {
              const banks = await fetchBanks();
              const found = banks.find(
                (b) => String(b.bankCode) === String(bankCode)
              );
              if (found) bankName = found.bankName;
            } catch {
              // ignore failure to fetch banks
            }
          }
        }

        setPaymentData({
          method: paymentMethod,
          cardData,
          savedCard,
          bank: bankCode,
          bankName,
          installments: installments
            ? Number.parseInt(installments)
            : undefined,
        });
      }
    };

    loadPaymentData();

    // Cargar datos de cuotas sin interés
    try {
      const stored = localStorage.getItem("checkout-zero-interest");
      if (stored) {
        const parsed = JSON.parse(stored) as CheckZeroInterestResponse;
        setZeroInterestData(parsed);
      }
    } catch (error) {
      console.error("Error loading zero interest data:", error);
    }

    // Cargar dirección de envío
    // Determinar método de entrega seleccionado
    const deliveryMethod =
      localStorage.getItem("checkout-delivery-method") || "domicilio";

    if (deliveryMethod === "tienda") {
      const storeStr = localStorage.getItem("checkout-store");
      if (storeStr) {
        try {
          const parsedStore = JSON.parse(storeStr);
          setShippingData({
            type: "pickup",
            store: {
              name:
                parsedStore.descripcion ||
                parsedStore.nombre ||
                "Tienda seleccionada",
              address: parsedStore.direccion,
              city: parsedStore.ciudad || parsedStore.departamento,
              schedule: parsedStore.horario,
            },
          });
        } catch (error) {
          console.error("Error parsing checkout-store:", error);
          setShippingData({
            type: "pickup",
          });
        }
      } else {
        setShippingData({
          type: "pickup",
        });
      }
    } else {
      // Buscar primero en checkout-address, si no existe buscar en imagiq_default_address (para invitados)
      let shippingAddress = localStorage.getItem("checkout-address");
      if (!shippingAddress) {
        shippingAddress = localStorage.getItem("imagiq_default_address");
        //         console.log("📍 [Step7 - useEffect] No hay checkout-address, usando imagiq_default_address para invitado");
      }

      if (shippingAddress) {
        try {
          const parsed = JSON.parse(shippingAddress);
          //           console.log("📍 [Step7 - useEffect] Dirección de envío cargada desde localStorage:", parsed);
          //           console.log("📍 [Step7 - useEffect] UUID de dirección:", parsed.id);
          //           console.log("📍 [Step7 - useEffect] Usuario ID (de dirección):", parsed.usuario_id);
          //           console.log("📍 [Step7 - useEffect] Línea uno:", parsed.linea_uno || parsed.direccionFormateada);
          //           console.log("📍 [Step7 - useEffect] Ciudad:", parsed.ciudad);
          //           console.log("📍 [Step7 - useEffect] Código DANE:", parsed.codigo_dane);
          setShippingData({
            type: "delivery",
            address: parsed.linea_uno || parsed.direccionFormateada || parsed.lineaUno,
            city: parsed.ciudad,
          });
        } catch (error) {
          console.error("Error parsing shipping address:", error);
        }
      } else {
        console.warn("⚠️ [Step7 - useEffect] No se encontró dirección en localStorage (ni checkout-address ni imagiq_default_address)");
      }
    }

    // Cargar datos de facturación
    const billingDataStr = localStorage.getItem("checkout-billing-data");
    if (billingDataStr) {
      try {
        const parsed = JSON.parse(billingDataStr);
        setBillingData(parsed);
      } catch (error) {
        console.error("Error parsing billing data:", error);
      }
    }

    // Cargar datos del receptor
    try {
      const receivedByClientStr = localStorage.getItem("checkout-received-by-client");
      const recipientDataStr = localStorage.getItem("checkout-recipient-data");
      // Leemos también billing data para tener los datos del cliente si él recibe
      const billingDataStr = localStorage.getItem("checkout-billing-data");
      const userStr = localStorage.getItem("imagiq_user");

      const receivedByClient = receivedByClientStr ? JSON.parse(receivedByClientStr) : true;

      if (!receivedByClient && recipientDataStr) {
        const parsed = JSON.parse(recipientDataStr);
        setRecipientData({
          receivedByClient: false,
          firstName: parsed.firstName,
          lastName: parsed.lastName,
          email: parsed.email,
          phone: parsed.phone,
        });
      } else {
        // Si recibe el cliente, intentamos poblar con sus datos
        let clientFirstName = "";
        let clientLastName = "";
        let clientEmail = "";
        let clientPhone = "";

        // Prioridad 1: datos del cliente kiosco (tiene nombre, apellido, email, celular)
        const kioskClientStr = localStorage.getItem("kiosk_client_id");
        if (kioskClientStr) {
          try {
            const kioskClient = JSON.parse(kioskClientStr);
            clientFirstName = kioskClient.nombre || "";
            clientLastName = kioskClient.apellido || "";
            clientEmail = kioskClient.email || "";
            clientPhone = kioskClient.celular || "";
          } catch (e) { console.error("Error parsing kiosk client for recipient", e); }
        } else if (billingDataStr) {
          try {
            const billing = JSON.parse(billingDataStr);
            // Intentar separar nombre y apellido si vienen juntos
            const nameParts = (billing.nombre || "").trim().split(" ");
            if (nameParts.length > 0) {
              clientFirstName = nameParts[0];
              clientLastName = nameParts.slice(1).join(" ");
            }
            clientEmail = billing.email || "";
            clientPhone = billing.telefono || "";
          } catch (e) { console.error("Error parsing billing for recipient", e); }
        } else if (userStr) {
          try {
            const user = JSON.parse(userStr);
            clientFirstName = user.nombre || "";
            clientLastName = user.apellido || "";
            clientEmail = user.email || "";
            clientPhone = user.telefono || user.celular || "";
          } catch (e) { console.error("Error parsing user for recipient", e); }
        }

        setRecipientData({
          receivedByClient: true,
          firstName: clientFirstName,
          lastName: clientLastName,
          email: clientEmail,
          phone: clientPhone,
        });
      }
    } catch (error) {
      console.error("Error parsing recipient data:", error);
      setRecipientData({ receivedByClient: true });
    }

    // Load Trade-In data (nuevo formato de mapa)
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

  }, [authContext.user?.id, loggedUser?.id, loadSavedCards]);

  // Estado para tracking de validación de Trade-In
  const [isValidatingTradeIn, setIsValidatingTradeIn] = useState(false);
  const tradeInValidationDoneRef = useRef(false);

  // CRÍTICO: Validar Trade-Ins activos al cargar Step7
  // Llama al endpoint checkSkuForTradeIn para verificar si el producto aún aplica para Trade-In
  useEffect(() => {
    const validateActiveTradeIns = async () => {
      // Solo ejecutar una vez y si hay Trade-Ins activos
      if (tradeInValidationDoneRef.current) return;

      const tradeInKeys = Object.keys(tradeInDataMap);
      if (tradeInKeys.length === 0) return;

      tradeInValidationDoneRef.current = true;
      setIsValidatingTradeIn(true);

      // console.log('[Step7] 🔍 Validando Trade-Ins activos:', tradeInKeys);

      const skusToRemove: string[] = [];

      for (const sku of tradeInKeys) {
        const tradeIn = tradeInDataMap[sku];
        if (!tradeIn?.completed) continue;

        try {
          // console.log(`[Step7] 🔍 Verificando SKU: ${sku}`);
          const response = await tradeInEndpoints.checkSkuForTradeIn({ sku });

          // console.log(`[Step7] 📋 Respuesta checkSkuForTradeIn para ${sku}:`, response);

          if (response.success && response.data) {
            const indRetoma = response.data.indRetoma ?? (response.data.aplica ? 1 : 0);
            // console.log(`[Step7] ✅ SKU ${sku} - indRetoma: ${indRetoma}`);

            // Si indRetoma === 0, el producto ya no aplica para Trade-In
            if (indRetoma === 0) {
              // console.log(`[Step7] ❌ SKU ${sku} ya NO aplica para Trade-In, marcando para eliminar`);
              skusToRemove.push(sku);
            }
          } else {
            // Si la respuesta no es exitosa, asumir que no aplica
            console.warn(`[Step7] ⚠️ No se pudo validar SKU ${sku}, respuesta:`, response);
            skusToRemove.push(sku);
          }
        } catch (error) {
          console.error(`[Step7] ❌ Error validando Trade-In para SKU ${sku}:`, error);
          // En caso de error, NO eliminar el Trade-In para no afectar al usuario
        }
      }

      // Eliminar Trade-Ins que ya no aplican
      if (skusToRemove.length > 0) {
        // console.log('[Step7] 🗑️ Eliminando Trade-Ins que ya no aplican:', skusToRemove);

        const updatedMap = { ...tradeInDataMap };
        for (const sku of skusToRemove) {
          delete updatedMap[sku];
        }

        setTradeInDataMap(updatedMap);

        // Actualizar localStorage
        if (Object.keys(updatedMap).length > 0) {
          localStorage.setItem("imagiq_trade_in", JSON.stringify(updatedMap));
        } else {
          localStorage.removeItem("imagiq_trade_in");
        }

        // Mostrar notificación al usuario
        toast.error("Beneficio no disponible", {
          description: "El beneficio Estreno y Entrego ya no está disponible para este producto. Se ha removido de tu orden.",
          duration: 6000,
        });

        // Si se eliminaron todos los Trade-Ins y el método de envío es "tienda", cambiar a "domicilio"
        if (Object.keys(updatedMap).length === 0) {
          const currentMethod = localStorage.getItem("checkout-delivery-method");
          if (currentMethod === "tienda") {
            localStorage.setItem("checkout-delivery-method", "domicilio");
            window.dispatchEvent(
              new CustomEvent("delivery-method-changed", { detail: { method: "domicilio" } })
            );
            window.dispatchEvent(new Event("storage"));
          }
        }
      } else {
        // console.log('[Step7] ✅ Todos los Trade-Ins siguen activos');
      }

      setIsValidatingTradeIn(false);
    };

    validateActiveTradeIns();
  }, [tradeInDataMap]);

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

  // Estado para validación de Trade-In
  const [tradeInValidation, setTradeInValidation] = useState<{
    isValid: boolean;
    productsWithoutRetoma: typeof products;
    hasMultipleProducts: boolean;
    errorMessage?: string;
  }>({ isValid: true, productsWithoutRetoma: [], hasMultipleProducts: false });

  // Validar Trade-In cuando cambian los productos
  useEffect(() => {
    const validation = validateTradeInProducts(products);
    setTradeInValidation(validation);

    // Si el producto ya no aplica (indRetoma === 0), quitar banner inmediatamente y mostrar notificación
    if (
      validation.isValid === false &&
      validation.errorMessage !== undefined &&
      validation.errorMessage.includes("Te removimos")
    ) {
      // Limpiar localStorage inmediatamente
      localStorage.removeItem("imagiq_trade_in");

      // Quitar el banner inmediatamente
      setTradeInDataMap({});

      // Mostrar notificación toast
      toast.error("Cupón removido", {
        description:
          "El producto seleccionado ya no aplica para el beneficio Estreno y Entrego",
        duration: 5000,
      });
    }
  }, [products]);

  // Redirigir a Step3 si la dirección cambia desde el header
  useEffect(() => {
    const handleAddressChange = (event: Event) => {
      const customEvent = event as CustomEvent;
      const fromHeader = customEvent.detail?.fromHeader;

      if (fromHeader) {
        //         console.log("🔄 Dirección cambiada desde header en Step7, redirigiendo a Step3...");
        router.push("/carrito/step3");
      } else {
        // Si cambia la dirección (pero no desde header), actualizar el estado
        try {
          const addressStr = localStorage.getItem('checkout-address');
          if (addressStr) {
            const parsed = JSON.parse(addressStr);
            //             console.log("🔄 [Step7] Dirección actualizada desde evento:", parsed);
            setCheckoutAddress(parsed);
          }
        } catch (error) {
          console.error("❌ [Step7] Error al actualizar dirección:", error);
        }
      }
    };

    // Escuchar cambios en localStorage también
    const handleStorageChange = (event: StorageEvent) => {
      if (event.key === 'checkout-address' && event.newValue) {
        try {
          const parsed = JSON.parse(event.newValue);
          //           console.log("🔄 [Step7] Dirección actualizada desde storage event:", parsed);
          setCheckoutAddress(parsed);
        } catch (error) {
          console.error("❌ [Step7] Error al parsear dirección de storage:", error);
        }
      }
    };

    globalThis.window.addEventListener(
      "address-changed",
      handleAddressChange as EventListener
    );
    globalThis.window.addEventListener("storage", handleStorageChange);

    return () => {
      globalThis.window.removeEventListener(
        "address-changed",
        handleAddressChange as EventListener
      );
      globalThis.window.removeEventListener("storage", handleStorageChange);
    };
  }, [router]);

  // Verificar cobertura cuando los productos estén cargados
  useEffect(() => {
    const verifyWhenProductsReady = async () => {
      // Solo ejecutar si hay productos
      if (products.length === 0) {
        setIsLoadingShippingMethod(false);
        return;
      }

      // CRÍTICO: Iniciar loading
      // - isLoadingCanPickUp: Para el skeleton (espera solo canPickUp)
      // - isCalculatingShipping: Para el botón (espera cálculo de envío completo)
      setIsLoadingCanPickUp(true);
      setIsLoadingShippingMethod(true);
      setIsLoadingStoreValidation(true);

      // Bandera para saber si es pickup (solo verificar canPickUp, no calcular envío)
      const isPickupMethod = shippingData?.type === "pickup";

      // Si NO es pickup, también activar el cálculo de envío
      if (!isPickupMethod) {
        setIsCalculatingShipping(true);
      }

      // PASO 1: Obtener canPickUp global del endpoint candidate-stores
      try {
        const user = safeGetLocalStorage<{ id?: string; user_id?: string }>(
          "imagiq_user",
          {}
        );
        const userId = user?.id || user?.user_id;

        // Usar un ID efectivo para la lógica de caché y peticiones
        // Si es invitado, usamos "anonymous" para intentar recuperar/guardar en caché y hacer la petición
        // asumiendo que el backend puede manejarlo o que recuperaremos del caché si ya se hizo en pasos previos
        const effectiveUserId = userId || "anonymous";

        // Preparar TODOS los productos del carrito para una sola petición
        const productsToCheck = products.map((p) => ({
          sku: p.sku,
          quantity: p.quantity,
        }));

        // Crear hash único de la petición (productos + userId)
        const requestHash = JSON.stringify({
          products: productsToCheck,
          userId: effectiveUserId,
        });

        // PROTECCIÓN CRÍTICA: Si esta misma petición ya falló antes, NO reintentar
        if (failedCandidateStoresRef.current === requestHash) {
          console.error("🚫 Esta petición a candidate-stores ya falló anteriormente. NO se reintentará para evitar sobrecargar la base de datos.");
          // Usar Coordinadora por defecto
          setShippingVerification({
            envio_imagiq: false,
            todos_productos_im_it: false,
            en_zona_cobertura: true,
          });
          setIsLoadingCanPickUp(false);
          setIsLoadingShippingMethod(false);
          setIsCalculatingShipping(false);
          return;
        }

        // Primero intentamos recuperar del caché para respuesta inmediata (especialmente útil para invitados)
        try {
          const { buildGlobalCanPickUpKey, getFullCandidateStoresResponseFromCache, getGlobalCanPickUpFromCache } = await import('@/app/carrito/utils/globalCanPickUpCache');

          let currentAddressId = null;
          const savedAddress = localStorage.getItem("checkout-address");
          if (savedAddress) {
            const parsed = JSON.parse(savedAddress);
            currentAddressId = parsed.id || null;
          }

          const cacheKey = buildGlobalCanPickUpKey({
            userId: effectiveUserId,
            products: productsToCheck,
            addressId: currentAddressId,
          });

          // Verificar si tenemos datos en caché primero
          const cachedFullResponse = getFullCandidateStoresResponseFromCache(cacheKey);
          const cachedCanPickUp = getGlobalCanPickUpFromCache(cacheKey);

          if (cachedFullResponse && cachedCanPickUp !== null) {
            //             console.log("💾 [Step7] Datos recuperados del caché, evitando llamada a API:", { canPickUp: cachedCanPickUp });

            // Usar datos del caché para evitar la llamada
            // Nota: Podríamos retornar aquí si queremos confiar plenamente en el caché y no refrescar
            // Pero para mayor seguridad, dejaremos que continúe a la API si no es muy costoso, 
            // O podemos usar los datos cacheados y saltar la llamada.
            // Dado que el usuario reporta problemas de persistencia, confiar en el caché es buena idea.

            // Simulamos una respuesta exitosa con los datos del caché
            const responseData = cachedFullResponse as unknown as {
              nearest?: { codBodega?: string };
              codeBodega?: string;
            };
            let warehouseCode: string | undefined;
            if (responseData.nearest?.codBodega) {
              warehouseCode = responseData.nearest.codBodega;
            } else if (responseData.codeBodega) {
              warehouseCode = responseData.codeBodega;
            }

            setCandidateWarehouseCode(warehouseCode);

            // Continuamos el flujo como si hubiera respondido la API...
            // Pero necesitamos setear estados que se setean más abajo.
            // Para simplificar y no duplicar código masivo, simplemente dejamos que el código siga
            // PERO usamos el effectiveUserId en la llamada real abajo.
          }
        } catch (e) {
          console.warn("⚠️ [Step7] Error leyendo caché:", e);
        }

        // Llamar al endpoint con TODOS los productos agrupados
        const requestBody = {
          products: productsToCheck,
          user_id: effectiveUserId,
        };
        //         console.log("📤 [Step7] Llamando getCandidateStores con TODO el carrito, body:", JSON.stringify(requestBody, null, 2));

        // Llamar SOLO a candidate-stores (que analiza TODO el carrito completo)
        const response = await productEndpoints.getCandidateStores(requestBody);

        //         console.log("📥 [Step7] Respuesta de getCandidateStores:", JSON.stringify(response.data, null, 2));

        if (response.success && response.data) {
          // Si la petición fue exitosa, limpiar el hash de fallo si existía
          if (failedCandidateStoresRef.current === requestHash) {
            failedCandidateStoresRef.current = null;
          }

          const responseData = response.data as {
            canPickUp?: boolean;
            canPickup?: boolean;
            codeBodega?: string;
            nearest?: {
              codBodega?: string;
            };
          };

          //           console.log("📥 [Step7] Respuesta de getCandidateStores:", JSON.stringify(responseData, null, 2));

          // Obtener codBodega de candidate-stores (analiza TODO el carrito)
          // console.log("🔍 [Step7] responseData completo:", responseData);

          let warehouseCode: string | undefined;

          // candidate-stores devuelve la estructura con nearest que contiene la bodega más cercana
          // que puede surtir TODO el pedido completo
          if (responseData.nearest?.codBodega) {
            warehouseCode = responseData.nearest.codBodega;
            // console.log("🔍 [Step7] codBodega tomado de responseData.nearest:", warehouseCode);
          } else if (responseData.codeBodega) {
            warehouseCode = responseData.codeBodega;
            // console.log("🔍 [Step7] codBodega tomado de responseData.codeBodega:", warehouseCode);
          }

          //           console.log("🏭 [Step7] codBodega final (de candidate-stores):", warehouseCode);

          // Guardar en estado para usar al crear la orden
          setCandidateWarehouseCode(warehouseCode);

          // Obtener canPickUp global de la respuesta
          const globalCanPickUp =
            responseData.canPickUp ?? responseData.canPickup ?? false;

          //           console.log(`🔍 [Step7] canPickUp global: ${globalCanPickUp}, isPickupMethod: ${isPickupMethod}`);

          // Actualizar caché global para que Step4OrderSummary lo muestre
          try {
            const { buildGlobalCanPickUpKey, setGlobalCanPickUpCache } = await import('@/app/carrito/utils/globalCanPickUpCache');

            // Obtener dirección actual para la clave del caché
            let currentAddressId = null;
            const savedAddress = localStorage.getItem("checkout-address");
            if (savedAddress) {
              const parsed = JSON.parse(savedAddress);
              currentAddressId = parsed.id || null;
            }

            const cacheKey = buildGlobalCanPickUpKey({
              userId,
              products: productsToCheck,
              addressId: currentAddressId,
            });

            // Guardar en caché y notificar
            // casting a any porque responseData tiene una estructura compatible pero no idéntica a CandidateStoresResponse
            setGlobalCanPickUpCache(cacheKey, globalCanPickUp, responseData as any, currentAddressId);
            //             console.log("💾 [Step7] Caché global actualizado con respuesta de candidate-stores");
          } catch (cacheError) {
            console.error("❌ [Step7] Error actualizando caché global:", cacheError);
          }

          // CRÍTICO: Ya tenemos canPickUp, ocultar skeleton INMEDIATAMENTE
          setIsLoadingCanPickUp(false);
          setIsLoadingShippingMethod(false);
          //           console.log("✅ [Step7] canPickUp obtenido - Ocultando skeleton");

          // IMPORTANTE: Si es método pickup, solo validamos canPickUp y terminamos (no calcular cobertura)
          if (isPickupMethod) {
            //             console.log("🏪 [Step7] Método pickup - Solo verificación de canPickUp, no calcular cobertura");
            setIsCentroDistribucion(false);
            setIsLoadingStoreValidation(false);
            // No establecer shippingVerification porque no es necesario para pickup
            return;
          }

          // Si llegamos aquí, es método "delivery" → Continuar calculando cobertura en segundo plano
          //           console.log("📦 [Step7] Método delivery - Calculando cobertura en segundo plano");
          // El skeleton ya está oculto, pero el botón seguirá en loading hasta terminar

          // ---------------------------------------------------------------------------
          // NUEVO: Cotización Multi-Origen (Solo para Domicilio)
          try {
            // 1. Obtener ciudades de origen únicas de candidate-stores response
            const originCities = new Set<string>();

            // Interfaz auxiliar para evitar el uso de any
            interface StoreDataLike {
              ciudad?: string;
              city?: string;
              nearest?: { ciudad?: string; city?: string };
              stores?: StoreDataLike[];
            }

            // candidate-stores devuelve response.data que es CandidateStoresResponse
            // Intentar obtener ciudad desde la respuesta
            if (response.data) {
              // response.data es CandidateStoresResponse, por lo que tiene la propiedad stores
              // pero necesitamos asegurarnos de que TypeScript lo sepa
              const storesMap = (response.data as unknown as { stores: Record<string, StoreDataLike[]> }).stores;
              if (storesMap) {
                Object.values(storesMap).forEach((storesList) => {
                  if (Array.isArray(storesList)) {
                    storesList.forEach((s) => {
                      if (s.ciudad) originCities.add(s.ciudad);
                    });
                  }
                });
              }
            }

            //             console.log("🏙️ [Step7] Ciudades de origen encontradas:", Array.from(originCities));

            // 2. Obtener ciudad de destino
            const destinationCity = shippingData?.city ||
              (checkoutAddress?.codigo_dane || checkoutAddress?.ciudad);

            // 3. Llamar al endpoint si tenemos datos suficientes
            if (originCities.size > 0 && destinationCity) {
              //               console.log("🚚 [Step7] Iniciando cotización multi-origen...");

              // Preparar detalle de productos (asumiendo 1kg por unidad como solicitado)
              const quoteDetails = products.map(p => ({
                ubl: 0, // Valor por defecto
                alto: 10, // Valor por defecto
                ancho: 10, // Valor por defecto
                largo: 10, // Valor por defecto
                peso: p.quantity, // 1kg por unidad * cantidad
                unidades: p.quantity
              }));

              const quotePayload = {
                ciudades_origen: Array.from(originCities),
                ciudad_destino: destinationCity,
                cuenta: "1", // Valor por defecto
                producto: "0", // Valor por defecto
                valoracion: String(calculations.total || 100000), // Valor del carrito o default
                nivel_servicio: [1], // Valor por defecto
                detalle: quoteDetails
              };

              // Llamada asíncrona (no bloquea el flujo principal)
              deliveryEndpoints.quoteNationalMultiOrigin(quotePayload)
                .then(quoteResponse => {
                  if (quoteResponse.success) {
                    //                     console.log("✅ [Step7] Cotización Multi-Origen Exitosa:", quoteResponse.data);
                    // Aquí se podría guardar en estado si se necesitara mostrar en UI
                    // setMultiOriginQuote(quoteResponse.data);
                  } else {
                    console.warn("⚠️ [Step7] Falló cotización multi-origen:", quoteResponse.message);
                  }
                })
                .catch(err => {
                  console.error("❌ [Step7] Error en cotización multi-origen:", err);
                });
            } else {
              //               console.log("⚠️ [Step7] No se pudo cotizar multi-origen: Faltan ciudades origen o destino", { originCities: Array.from(originCities), destinationCity });
            }
          } catch (quoteError) {
            console.error("❌ [Step7] Error inesperado en lógica de cotización:", quoteError);
          }
          // ---------------------------------------------------------------------------

          // PASO 2: Verificar si es Centro de Distribución
          const esCentroDistribucion = warehouseCode === "001";
          setIsCentroDistribucion(esCentroDistribucion);
          setIsLoadingStoreValidation(false);

          // Si NO es pickup y NO es Centro de Distribución, pre-configurar Coordinadora como fallback
          // pero dejar que continúe al PASO 3 para verificar cobertura real
          if (!globalCanPickUp && !esCentroDistribucion) {
            //             console.log("🏪 [Step7] NO es Centro de Distribución - Configurando Coordinadora como base pero verificando cobertura");
            // Configuración inicial (se sobrescribirá si el endpoint dice otra cosa)
            const verification = {
              envio_imagiq: false,
              todos_productos_im_it: false,
              en_zona_cobertura: true,
            };
            setShippingVerification(verification);
            localStorage.setItem("checkout-envio-imagiq", "false");
            // NO hacer return, continuar a la verificación
          }

          // PASO 3: SIEMPRE verificar cobertura Imagiq (incluso si canPickUp es false)
          // Esto asegura que siempre tengamos la información completa de verificación
          // console.log("🔍 [Step7] Verificando cobertura Imagiq (canPickUp:", globalCanPickUp, ", esCentroDistribucion:", esCentroDistribucion, ")");
          const shippingAddress = localStorage.getItem("checkout-address");
          if (!shippingAddress) {
            const verification = {
              envio_imagiq: false,
              todos_productos_im_it: false,
              en_zona_cobertura: true,
            };
            setShippingVerification(verification);
            // Guardar en localStorage como respaldo
            localStorage.setItem("checkout-envio-imagiq", "false");
            setIsLoadingShippingMethod(false);
            return;
          }

          const parsed = JSON.parse(shippingAddress);
          const requestBody = {
            direccion_id: parsed.id,
            skus: products.map((p) => p.sku),
          };

          const data = await apiPost<ShippingVerification>(
            "/api/addresses/zonas-cobertura/verificar-por-id",
            requestBody
          );

          const verification = {
            envio_imagiq: data.envio_imagiq || false,
            todos_productos_im_it: data.todos_productos_im_it || false,
            en_zona_cobertura: data.en_zona_cobertura || false,
          };
          setShippingVerification(verification);
          // Guardar en localStorage como respaldo para asegurar que esté disponible al crear la orden
          localStorage.setItem("checkout-envio-imagiq", String(verification.envio_imagiq));
          setIsCalculatingShipping(false);
          //           console.log("✅ [Step7] Cálculo de envío completado - Habilitando botón");
        } else {
          // Si falla la petición, marcar este hash como fallido
          failedCandidateStoresRef.current = requestHash;
          console.error(`🚫 Petición a candidate-stores falló. Hash bloqueado: ${requestHash.substring(0, 50)}...`);
          console.error("🚫 Esta petición NO se reintentará automáticamente para proteger la base de datos.");
          // Si falla la petición de candidate-stores, usar Coordinadora
          // console.log("🚛 Error en candidate-stores, usando Coordinadora");
          const verification = {
            envio_imagiq: false,
            todos_productos_im_it: false,
            en_zona_cobertura: true,
          };
          setShippingVerification(verification);
          // Guardar en localStorage como respaldo
          localStorage.setItem("checkout-envio-imagiq", "false");
          setIsLoadingCanPickUp(false);
          setIsLoadingShippingMethod(false);
          setIsCalculatingShipping(false);
        }
      } catch (error) {
        // Si hay un error en el catch, también marcar como fallido
        const productsToCheck = products.map((p) => ({
          sku: p.sku,
          quantity: p.quantity,
        }));
        const user = safeGetLocalStorage<{ id?: string; user_id?: string }>(
          "imagiq_user",
          {}
        );
        const userId = user?.id || user?.user_id;
        const requestHash = JSON.stringify({
          products: productsToCheck,
          userId,
        });

        failedCandidateStoresRef.current = requestHash;
        console.error(
          "🚫 Error verifying shipping coverage - Petición bloqueada para evitar sobrecargar BD:",
          error
        );
        console.error(`🚫 Hash bloqueado: ${requestHash.substring(0, 50)}...`);
        console.error("🚫 Esta petición NO se reintentará automáticamente.");
        // En caso de error, usar Coordinadora por defecto
        const verification = {
          envio_imagiq: false,
          todos_productos_im_it: false,
          en_zona_cobertura: true,
        };
        setShippingVerification(verification);
        // Guardar en localStorage como respaldo
        localStorage.setItem("checkout-envio-imagiq", "false");
        setIsLoadingStoreValidation(false);
        setIsLoadingCanPickUp(false);
        setIsLoadingShippingMethod(false);
        setIsCalculatingShipping(false);
      }
    };

    verifyWhenProductsReady();
  }, [products, shippingData]);

  // Calcular si la compra aplica para 0% interés y guardarlo en localStorage
  useEffect(() => {
    try {
      const computeAndStore = () => {
        // Leer objeto existente en localStorage (si existe)
        const storedStr = localStorage.getItem("checkout-zero-interest");
        let storedObj: Record<string, unknown> | null = null;
        if (storedStr) {
          try {
            storedObj = JSON.parse(storedStr);
          } catch {
            storedObj = null;
          }
        }

        // Determinar valor global 'aplica' (preferir datos ya cargados en zeroInterestData)
        const globalAplica =
          zeroInterestData?.aplica !== undefined
            ? zeroInterestData.aplica
            : storedObj?.aplica ?? false;

        // Obtener id de tarjeta seleccionada (preferir paymentData.savedCard)
        const savedCardId =
          paymentData?.savedCard?.id ??
          (localStorage.getItem("checkout-saved-card-id") || null);

        // Obtener cuotas seleccionadas
        const installmentsFromState = paymentData?.installments;
        const installmentsFromStorage = localStorage.getItem(
          "checkout-installments"
        );
        const installments = (() => {
          if (installmentsFromState !== null && installmentsFromState !== undefined) return Number(installmentsFromState);
          if (installmentsFromStorage) return Number.parseInt(installmentsFromStorage, 10);
          return undefined;
        })();

        let aplica_zero_interes = false;

        if (globalAplica && savedCardId && zeroInterestData?.cards) {
          const matched = zeroInterestData.cards.find(
            (c) => String(c.id) === String(savedCardId)
          );
          if (
            matched &&
            matched.eligibleForZeroInterest &&
            installments !== undefined &&
            matched.availableInstallments.includes(installments)
          ) {
            aplica_zero_interes = true;
          }
        }

        // Actualizar el objeto en localStorage sin eliminar otras propiedades
        const updatedObj = {
          ...(storedObj || (zeroInterestData ? { ...zeroInterestData } : {})),
          aplica_zero_interes,
        };

        try {
          localStorage.setItem(
            "checkout-zero-interest",
            JSON.stringify(updatedObj)
          );
        } catch (err) {
          console.error(
            "Error saving checkout-zero-interest to localStorage",
            err
          );
        }
      };

      computeAndStore();
    } catch (err) {
      console.error("Error computing aplica_zero_interes:", err);
    }
  }, [paymentData, zeroInterestData]);

  // Escuchar eventos de validación 3DS
  const isRedirectingRef = useRef(false);

  // Escuchar eventos de validación 3DS
  useEffect(() => {
    const handle3DSMessage = (event: MessageEvent) => {
      // Filtrar mensajes que no sean de nuestra aplicación o del proceso 3DS
      if (!event.data) return;

      // console.log("📨 [Step7] Mensaje recibido:", event.data);

      let data = event.data;
      if (typeof data === 'string') {
        try {
          data = JSON.parse(data);
          // console.log("📨 [Step7] Mensaje parseado:", data);
        } catch (e) {
          // Si no es JSON válido, ignorar o usar data original si aplica
        }
      }

      // Verificar si es un mensaje de finalización de ePayco
      const isEpaycoEvent =
        data.success !== undefined ||
        data.message !== undefined ||
        (data.data && data.data.ref_payco) ||
        // Add support for Cardinal/profile.completed event
        (data.MessageType === 'profile.completed');

      if (isEpaycoEvent) {
        // console.log("🔐 [Step7] Evento 3DS detectado:", data);

        // Si ya estamos redirigiendo, ignorar eventos subsiguientes para evitar doble procesamiento
        if (isRedirectingRef.current) {
          // console.log("⏳ [Step7] Redirección en progreso, ignorando evento duplicado.");
          return;
        }

        // Caso 1: Éxito (success: true)
        // También aceptamos profile.completed con Status: true
        if (
          (data.success && data.success !== "false") || // Allow truthy success but not string "false"
          (data.data && data.data.ref_payco)
        ) {
          // console.log("Se obtuvo la ref_payco. Consulta la transacción para verificar su estado.");
          // console.log("✅ [Step7] 3DS Exitoso");

          const orderId = localStorage.getItem('pending_order_id');
          if (orderId) {
            // console.log("🔄 [Step7] Redirigiendo a verificación para orden:", orderId);
            isRedirectingRef.current = true; // Marcar que ya estamos redirigiendo
            localStorage.removeItem('pending_order_id');

            // console.log("🔄 [Step7] Redirigiendo a verificación para orden:", orderId);
            localStorage.removeItem('pending_order_id');

            // Se eliminó la limpieza manual de artefactos 3DS a petición del usuario
            // para evitar recargas de página o comportamientos inesperados de la librería.

            localStorage.removeItem('kiosk_client_id');
            router.push(`/verify-purchase/${orderId}`);
          } else {
            console.warn("⚠️ [Step7] Éxito en 3DS pero no se encontró pending_order_id");
            toast.error("Pago procesado, pero se perdió la referencia de la orden. Por favor revisa tu correo.");
            router.push('/');
          }
        }
        // Caso 2: Error o Fallo (success: false o message con error)
        else if (
          data.success === false ||
          data.message === "Error" ||
          (data.MessageType === "profile.completed" && data.Status === false)
        ) {
          console.error("❌ [Step7] 3DS Fallido/Rechazado:", data);
          toast.error("La autenticación 3D Secure falló. Por favor intenta con otro medio de pago.");
          localStorage.removeItem('pending_order_id');
          setIsProcessing(false);

          try {
            // Limpiar UI si falló
            const iframes = document.querySelectorAll('iframe');
            iframes.forEach(iframe => {
              if (iframe.src.includes('epayco') || iframe.src.includes('3ds') || iframe.id.includes('modal') || !iframe.id) {
                iframe.remove();
              }
            });
            document.body.style.overflow = '';
            document.body.style.paddingRight = '';
          } catch (e) {
            // ignore
          }
        }
      }
    };

    window.addEventListener("message", handle3DSMessage);
    return () => {
      window.removeEventListener("message", handle3DSMessage);
    };
  }, [router]);

  // Función que realmente procesa la orden (llamada después del modal o directamente)
  const processOrder = async () => {
    // Validar Trade-In antes de confirmar
    const validation = validateTradeInProducts(products);
    if (!validation.isValid) {
      alert(getTradeInValidationMessage(validation));
      return;
    }

    if (!billingData) {
      console.error("No billing data available");
      return;
    }

    // CRÍTICO: Si todavía está calculando el envío, esperar
    if (isCalculatingShippingRef.current) {
      //       console.log("⏳ [Step7] Usuario hizo clic pero todavía calculando envío - Esperando...");
      // El botón ya muestra "Calculando envío..." por el estado isCalculatingShipping
      // Esperar en un loop hasta que termine
      await new Promise<void>((resolve) => {
        const checkInterval = setInterval(() => {
          // Verificar el valor actual de la ref
          if (!isCalculatingShippingRef.current) {
            clearInterval(checkInterval);
            //             console.log("✅ [Step7] Cálculo de envío completado - Procediendo con la orden");
            resolve();
          }
        }, 100); // Verificar cada 100ms
      });
    }

    setIsProcessing(true);

    // =================================================================================
    // VALIDACIÓN CRÍTICA DE BODEGA Y COBERTURA (Recálculo si es null)
    // =================================================================================
    const currentDeliveryMethod = (localStorage.getItem("checkout-delivery-method") || "domicilio").toLowerCase();

    // console.log("🔍 [Step7] DEBUG - Estado inicial:", {
    // currentDeliveryMethod,
    // candidateWarehouseCode,
    // checkCondition: currentDeliveryMethod === "domicilio" && !candidateWarehouseCode
    // });

    // Variable local para la bodega (inicia con el estado actual)
    let finalWarehouseCode = candidateWarehouseCode;

    if (currentDeliveryMethod === "domicilio" && !finalWarehouseCode) {
      //       console.log("⚠️ [Step7] Bodega candidata es NULL. Intentando recalcular antes de procesar pago...");

      try {
        const user = safeGetLocalStorage<{ id?: string; user_id?: string }>(
          "imagiq_user",
          {}
        );
        const userId = user?.id || user?.user_id || "anonymous"; // Usar anonymous si no hay user para permitir cálculo

        // Preparar productos
        const productsToCheck = products.map((p) => ({
          sku: p.sku,
          quantity: p.quantity,
        }));

        const requestBody = {
          products: productsToCheck,
          user_id: userId,
        };

        //         console.log("🔄 [Step7] Recalculando candidate-stores...", JSON.stringify(requestBody));

        // Llamada de emergencia a candidate-stores
        const response = await productEndpoints.getCandidateStores(requestBody);

        if (response.success && response.data) {
          const responseData = response.data as {
            canPickUp?: boolean;
            canPickup?: boolean;
            codeBodega?: string;
            codigoBodega?: string;
            nearest?: { codBodega?: string; codigoBodega?: string };
            default?: { codBodega?: string; codigoBodega?: string };
            stores?: Record<string, Array<{ codBodega?: string; distance?: number }>>;
          };

          let newWarehouseCode: string | undefined;

          // Intentar múltiples caminos para obtener el código de bodega
          if (responseData.default?.codigoBodega) {
            newWarehouseCode = responseData.default.codigoBodega;
            //             console.log("✅ [Step7] Bodega encontrada en default.codigoBodega:", newWarehouseCode);
          } else if (responseData.default?.codBodega) {
            newWarehouseCode = responseData.default.codBodega;
            //             console.log("✅ [Step7] Bodega encontrada en default.codBodega:", newWarehouseCode);
          } else if (responseData.nearest?.codigoBodega) {
            newWarehouseCode = responseData.nearest.codigoBodega;
            //             console.log("✅ [Step7] Bodega encontrada en nearest.codigoBodega:", newWarehouseCode);
          } else if (responseData.nearest?.codBodega) {
            newWarehouseCode = responseData.nearest.codBodega;
            //             console.log("✅ [Step7] Bodega encontrada en nearest.codBodega:", newWarehouseCode);
          } else if (responseData.codigoBodega) {
            newWarehouseCode = responseData.codigoBodega;
            //             console.log("✅ [Step7] Bodega encontrada en codigoBodega:", newWarehouseCode);
          } else if (responseData.codeBodega) {
            newWarehouseCode = responseData.codeBodega;
            //             console.log("✅ [Step7] Bodega encontrada en codeBodega:", newWarehouseCode);
          } else if (responseData.stores) {
            // Si hay stores, usar la primera tienda de la primera ciudad (más cercana)
            const cities = Object.keys(responseData.stores);
            if (cities.length > 0) {
              const firstCity = cities[0];
              const storesInCity = responseData.stores[firstCity];
              if (storesInCity && storesInCity.length > 0 && storesInCity[0].codBodega) {
                newWarehouseCode = storesInCity[0].codBodega;
                //                 console.log(`✅ [Step7] Bodega encontrada en stores.${firstCity}[0].codBodega:`, newWarehouseCode);
              }
            }
          }

          if (newWarehouseCode) {
            //             console.log("✅ [Step7] Recálculo exitoso. Bodega encontrada:", newWarehouseCode);
            setCandidateWarehouseCode(newWarehouseCode); // Actualizar estado para la UI
            finalWarehouseCode = newWarehouseCode; // Actualizar variable local para uso inmediato
          } else {
            console.warn("⚠️ [Step7] Recálculo completado pero NO se obtuvo bodega válida.");
            // console.log("🔍 [Step7] Estructura de respuesta recibida:", JSON.stringify(responseData, null, 2));
          }
        } else {
          console.error("❌ [Step7] Falló el recálculo de candidate-stores.");
        }
      } catch (recalcError) {
        console.error("❌ [Step7] Error crítico recalculando bodega:", recalcError);
      }
    }

    const esFacturaEmpresa = billingData.type === "juridica";

    // Preparar información de facturación de forma segura
    const informacion_facturacion = {
      direccion_id: billingData.direccion?.id ?? "",
      email: billingData.email ?? "",
      nombre_completo: billingData.nombre ?? "",
      numero_documento: billingData.documento ?? "",
      tipo_documento: billingData.tipoDocumento ?? "",
      telefono: billingData.telefono ?? "",
      type: billingData.type ?? "",
      // El formulario conserva la razon social, el NIT y el representante de una
      // compra anterior aunque el cliente cambie a Persona Natural, asi que la
      // orden quedaba marcada como natural pero cargando los datos de una
      // empresa. Cuando no se factura a una empresa estos tres campos viajan
      // vacios.
      //
      // El nombre del representante legal no lo pide ningun campo del
      // formulario, asi que su `||` caia siempre en la razon social y Novasoft
      // recibia el nombre de la empresa donde espera una persona: ahora va el
      // nombre y apellido del contacto.
      nit: esFacturaEmpresa ? billingData.nit : "",
      razon_social: esFacturaEmpresa ? billingData.razonSocial : "",
      representante_legal: esFacturaEmpresa
        ? billingData.nombreRepresentante || billingData.nombre
        : "",
    };

    try {
      // Helper to build beneficios array
      const buildBeneficios = (): BeneficiosDTO[] => {
        const beneficios: BeneficiosDTO[] = [];
        try {
          // Trade-In (entrego_y_estreno) - soporta nuevo formato de mapa
          const tradeStr = localStorage.getItem("imagiq_trade_in");
          // console.log('[Step7 buildBeneficios] Raw trade-in localStorage:', tradeStr);
          if (tradeStr) {
            const parsedTrade = JSON.parse(tradeStr);
            // console.log('[Step7 buildBeneficios] Parsed trade-in:', parsedTrade);
            // Verificar si es formato nuevo (mapa) o antiguo (objeto único)
            if (typeof parsedTrade === 'object' && !parsedTrade.deviceName) {
              // Formato nuevo: { "SKU1": { completed, deviceName, value, detalles }, ... }
              // console.log('[Step7 buildBeneficios] Detected NEW format (map), keys:', Object.keys(parsedTrade));
              for (const [sku, tradeIn] of Object.entries(parsedTrade)) {
                const t = tradeIn as { completed?: boolean; deviceName?: string; value?: number; detalles?: DetalleDispositivoRetoma };
                // console.log(`[Step7 buildBeneficios] Processing SKU: ${sku}, completed: ${t?.completed}, deviceName: ${t?.deviceName}, value: ${t?.value}`);
                // Aceptar si completed es true O si tiene deviceName y value (para compatibilidad)
                if (t?.completed || (t?.deviceName && t?.value)) {
                  const beneficio = {
                    type: "entrego_y_estreno" as const,
                    dispositivo_a_recibir: t.deviceName,
                    valor_retoma: t.value,
                    detalles_dispositivo_a_recibir: t.detalles,
                    sku: sku, // SKU del producto (backend espera 'sku', no 'sku_producto')
                  };
                  // console.log('[Step7 buildBeneficios] Adding trade-in beneficio:', beneficio);
                  beneficios.push(beneficio);
                }
              }
            } else if (parsedTrade?.completed || (parsedTrade?.deviceName && parsedTrade?.value)) {
              // Formato antiguo: { completed, deviceName, value }
              // console.log('[Step7 buildBeneficios] Detected OLD format');
              beneficios.push({
                type: "entrego_y_estreno",
                dispositivo_a_recibir: parsedTrade.deviceName,
                valor_retoma: parsedTrade.value,
                detalles_dispositivo_a_recibir: parsedTrade.detalles,
              });
            }
          }

          // 0% interes
          const zeroStr = localStorage.getItem("checkout-zero-interest");
          if (zeroStr) {
            const parsedZero = JSON.parse(zeroStr);
            const aplicaZero =
              parsedZero?.aplica_zero_interes || parsedZero?.aplica;
            if (aplicaZero && paymentData?.method === "tarjeta") {
              const cardId =
                paymentData?.savedCard?.id ||
                localStorage.getItem("checkout-saved-card-id");
              const installments =
                paymentData?.installments ??
                Number.parseInt(
                  localStorage.getItem("checkout-installments") || "0"
                );
              const matched = parsedZero?.cards?.find(
                (c: {
                  id: string;
                  eligibleForZeroInterest: boolean;
                  availableInstallments: number[];
                }) => String(c.id) === String(cardId)
              );
              if (
                matched?.eligibleForZeroInterest &&
                matched.availableInstallments?.includes(Number(installments))
              ) {
                beneficios.push({ type: "0%_interes" });
              }
            }
          }
        } catch (err) {
          console.error('[Step7 buildBeneficios] Error:', err);
        }
        // console.log('[Step7 buildBeneficios] BENEFICIOS FINALES:', JSON.stringify(beneficios, null, 2));
        if (beneficios.length === 0) return [{ type: "sin_beneficios" }];
        return beneficios;
      };
      // Determinar método de envío y código de bodega
      const deliveryMethod = (
        localStorage.getItem("checkout-delivery-method") || "domicilio"
      ).toLowerCase();

      // Determinar metodo_envio: 1=Coordinadora, 2=Pickup, 3=Imagiq
      let metodo_envio = 1; // Por defecto Coordinadora

      if (deliveryMethod === "tienda") {
        metodo_envio = 2; // Pickup en tienda
      } else if (deliveryMethod === "domicilio") {
        // Verificar si es envío Imagiq desde shippingVerification o localStorage
        const envioImagiq =
          shippingVerification?.envio_imagiq === true ||
          localStorage.getItem("checkout-envio-imagiq") === "true";

        if (envioImagiq) {
          metodo_envio = 3; // Envío Imagiq
        } else {
          metodo_envio = 1; // Coordinadora
        }
      }

      // Log para debug - asegurar que el método de envío se está pasando correctamente
      //       console.log("📦 [Step7] Método de envío determinado:", {
      // deliveryMethod,
      // metodo_envio,
      // envio_imagiq: shippingVerification?.envio_imagiq,
      // shippingVerification: shippingVerification
      // });

      // Validar que tenemos la dirección de envío
      //       console.log("� [Step7 - Validación] ========== VALIDACIÓN DE DIRECCIÓN ==========");
      // console.log("🔍 [Step7 - Validación] checkoutAddress completo:", checkoutAddress);
      // console.log("🔍 [Step7 - Validación] checkoutAddress?.id:", checkoutAddress?.id);
      // console.log("🔍 [Step7 - Validación] Tipo de checkoutAddress?.id:", typeof checkoutAddress?.id);
      // console.log("🔍 [Step7 - Validación] ¿Es undefined?:", checkoutAddress?.id === undefined);
      // console.log("🔍 [Step7 - Validación] ¿Es null?:", checkoutAddress?.id === null);
      // console.log("🔍 [Step7 - Validación] ¿Es string vacío?:", checkoutAddress?.id === "");
      // console.log("🔍 [Step7 - Validación] Dirección de envío:", {
      // direccionId: checkoutAddress?.id,
      // linea_uno: checkoutAddress?.linea_uno,
      // ciudad: checkoutAddress?.ciudad,
      // codigo_dane: checkoutAddress?.codigo_dane
      // });
      // console.log("🔍 [Step7 - Validación] ============================================");

      // Defensive: re-read checkout-address from localStorage in case state is stale
      let effectiveAddress = checkoutAddress;
      if (!effectiveAddress?.id) {
        try {
          const freshAddressStr = localStorage.getItem('checkout-address');
          if (freshAddressStr) {
            const parsed = JSON.parse(freshAddressStr);
            if (parsed?.id) {
              console.log("🔄 [Step7 - Validación] Dirección recuperada desde localStorage (state era null):", parsed.id);
              effectiveAddress = parsed;
              setCheckoutAddress(parsed);
            }
          }
        } catch {
          // ignore parse errors
        }
      }

      if (!effectiveAddress?.id) {
        console.error("❌ [Step7 - Validación] ERROR: No se encontró el ID de la dirección");
        throw new Error("No se encontró la dirección de envío. Por favor, agrega una dirección antes de continuar.");
      }

      //       console.log("✅ [Step7 - Validación] Dirección válida con ID:", checkoutAddress.id);

      let codigo_bodega: string | undefined = undefined;

      if (deliveryMethod === "tienda") {
        // Para pickup: usar la tienda seleccionada
        try {
          const storeStr = localStorage.getItem("checkout-store");
          if (storeStr) {
            const parsedStore = JSON.parse(storeStr);
            codigo_bodega =
              parsedStore?.codBodega || parsedStore?.codigo || undefined;
          }
        } catch {
          // ignore
        }

        // VALIDACIÓN CRÍTICA PARA TIENDA
        if (!codigo_bodega) {
          console.error("❌ [Step7] ERROR: Método tienda seleccionado pero no hay codigo_bodega.");
          toast.error("Error: No se ha podido validar la tienda seleccionada. Por favor, selecciona la tienda nuevamente.");
          setIsProcessing(false);
          return;
        }
      } else {
        // Para delivery: usar la bodega de candidate-stores
        // Esta bodega puede surtir TODO el pedido completo
        // Usar la variable local finalWarehouseCode que puede haber sido actualizada por el recálculo

        // console.log("🔍 [Step7] DEBUG - Verificando finalWarehouseCode:", {
        // finalWarehouseCode,
        // candidateWarehouseCode,
        // tipoFinal: typeof finalWarehouseCode,
        // tipoCandidate: typeof candidateWarehouseCode
        // });

        codigo_bodega = finalWarehouseCode;

        // VALIDACIÓN CRÍTICA PARA DOMICILIO
        if (!codigo_bodega) {
          console.warn("⚠️ [Step7] ADVERTENCIA: Método domicilio seleccionado pero no hay codigo_bodega definido.");
          console.warn("⚠️ [Step7] Se procederá con la orden esperando que el backend resuelva la bodega o use multi-origen.");

          // NO detenemos el proceso, dejamos que el backend decida
          // toast.error("Lo sentimos, no pudimos asignar una bodega para tu envío. Por favor intenta recargar la página.");
          // setIsProcessing(false);
          // return;
        }

        //         console.log("🏭 [Step7] Usando bodega validada para delivery:", codigo_bodega);
      }

      // Log final antes de enviar al backend
      //       console.log("📤 [Step7] Datos que se enviarán al backend:", {
      // direccionId: checkoutAddress?.id,
      // userId: authContext.user?.id || String(loggedUser?.id),
      // codigo_bodega,
      // metodo_envio,
      // totalAmount: calculations.total,
      // shippingAmount: calculations.shipping
      // });

      // ========================================
      // 🔍 LOGS DETALLADOS DE DIRECCIÓN
      // ========================================
      //       console.log("🏠 [Step7] ========== INFORMACIÓN DE DIRECCIÓN ==========");
      //       console.log("🏠 [Step7] Dirección completa desde checkoutAddress:", checkoutAddress);
      //       console.log("🏠 [Step7] UUID de dirección (userInfo.direccionId):", checkoutAddress?.id);
      //       console.log("🏠 [Step7] UUID de dirección (informacion_facturacion.direccion_id):", informacion_facturacion.direccion_id);
      //       console.log("🏠 [Step7] Línea uno:", checkoutAddress?.linea_uno);
      //       console.log("🏠 [Step7] Ciudad:", checkoutAddress?.ciudad);
      //       console.log("🏠 [Step7] Código DANE:", checkoutAddress?.codigo_dane);
      //       console.log("🏠 [Step7] País:", checkoutAddress?.pais);
      //       console.log("🏠 [Step7] Usuario ID (de la dirección):", checkoutAddress?.usuario_id);
      //       console.log("🏠 [Step7] Usuario ID (del contexto):", authContext.user?.id || loggedUser?.id);
      //       console.log("🏠 [Step7] =============================================");

      // Destinatario de envío (step3). Si el cliente desmarcó "Será recibido por
      // el cliente" y puso a otra persona, lo mandamos para que el backend lo
      // guarde; si recibe el comprador, solo enviamos el flag.
      const recipientPayload =
        recipientData?.receivedByClient === false
          ? {
              receivedByClient: false,
              firstName: recipientData.firstName?.trim() || "",
              lastName: recipientData.lastName?.trim() || "",
              email: recipientData.email?.trim() || "",
              phone: recipientData.phone?.trim() || "",
            }
          : { receivedByClient: true };

      switch (paymentData?.method) {
        case "tarjeta": {
          // KIOSK MODE: Use datafono process flow (creates order + guides without recogida)
          if (isKioskMode) {
            console.log("🏪 [Step7] KIOSK MODE - Procesando orden datafono (tarjeta/efectivo)...");
            const kioskClientData = (() => {
              try { const kc = localStorage.getItem('kiosk_client_id'); return kc ? JSON.parse(kc) : null; } catch { return null; }
            })();

            const datafonoPayload = {
              totalAmount: String(calculations.total),
              shippingAmount: String(calculations.shipping),
              currency: "COP",
              items: products.map((p) => ({
                id: String(p.id),
                sku: String(p.sku),
                name: String(p.name),
                quantity: String(p.quantity),
                unitPrice: String(p.price),
                skupostback: p.skuPostback || p.sku || "",
                desDetallada: p.desDetallada || p.name || "",
                ean: p.ean && p.ean !== "" ? String(p.ean) : String(p.sku),
                category: p.categoria || "",
                ...(p.bundleInfo && {
                  bundleInfo: {
                    codCampana: p.bundleInfo.codCampana,
                    productSku: p.bundleInfo.productSku,
                    skusBundle: p.bundleInfo.skusBundle,
                    bundlePrice: p.bundleInfo.bundlePrice,
                    bundleDiscount: p.bundleInfo.bundleDiscount,
                    fechaFinal: p.bundleInfo.fechaFinal,
                  },
                }),
              })),
              metodo_envio,
              codigo_bodega,
              userInfo: {
                direccionId: effectiveAddress?.id || "",
                userId: (() => {
                  if (kioskClientData?.userId) return kioskClientData.userId;
                  return authContext.user?.id || String(loggedUser?.id);
                })(),
              },
              informacion_facturacion,
              beneficios: buildBeneficios(),
            recipientData: recipientPayload,
              kioskStoreId: authContext.user?.id || loggedUser?.id || "",
              ...getPostHogIds(),
            };

            // V2 webhook-driven flow: create order, post to Novasoft without
            // guides/payment, return immediately. The verify-purchase page
            // listens for `order_approved` over websocket — the backend fires
            // it from the WSiMagiQ billing webhook handler.
            const processRes = await kioskProcessDatafonoV2(datafonoPayload);

            if ("error" in processRes) {
              setError(processRes.message);
              throw new Error(processRes.message);
            }

            console.log("✅ [Step7] V2 Orden creada:", processRes.orderId, "Serial:", processRes.serialId);

            setIsProcessing(false);
            router.push(`/verify-purchase/${processRes.orderId}?from=kiosk&serial=${encodeURIComponent(processRes.serialId)}`);
            break;
          }

          // REGULAR (non-kiosk) card payment flow
          const res = await payWithCard({
            currency: "COP",
            dues: String(paymentData.installments || "1"),
            items: products.map((p) => ({
              id: String(p.id),
              sku: String(p.sku),
              name: String(p.name),
              quantity: String(p.quantity),
              unitPrice: String(p.price),
              skupostback: p.skuPostback || p.sku || "",
              desDetallada: p.desDetallada || p.name || "",
              ean: p.ean && p.ean !== "" ? String(p.ean) : String(p.sku),
              category: p.categoria || "",
              ...(p.bundleInfo && {
                bundleInfo: {
                  codCampana: p.bundleInfo.codCampana,
                  productSku: p.bundleInfo.productSku,
                  skusBundle: p.bundleInfo.skusBundle,
                  bundlePrice: p.bundleInfo.bundlePrice,
                  bundleDiscount: p.bundleInfo.bundleDiscount,
                  fechaFinal: p.bundleInfo.fechaFinal,
                },
              }),
            })),
            totalAmount: String(calculations.total),
            metodo_envio,
            codigo_bodega,
            shippingAmount: String(calculations.shipping),
            userInfo: {
              direccionId: effectiveAddress?.id || "",
              userId: (() => {
                const kc = localStorage.getItem('kiosk_client_id');
                if (kc) { try { const p = JSON.parse(kc); if (p?.userId) return p.userId; } catch { /* ignore */ } }
                return authContext.user?.id || String(loggedUser?.id);
              })(),
            },
            // Pass cardTokenId only if savedCard exists
            cardTokenId: paymentData.savedCard?.id || "",
            // Pass raw card data if NO savedCard (temporary card)
            ...(!paymentData.savedCard?.id && paymentData.cardData ? {
              cardNumber: paymentData.cardData.cardNumber,
              cardCvc: paymentData.cardData.cardCvc,
              cardExpMonth: paymentData.cardData.cardExpMonth,
              cardExpYear: paymentData.cardData.cardExpYear,
            } : {}),
            informacion_facturacion,
            beneficios: buildBeneficios(),
            recipientData: recipientPayload,
          });

          if ("error" in res) {
            setError(res.message);
            throw new Error(res.message);
          }

          // Verificar si requiere 3DS
          if (res.requires3DS) {
            if (res.data3DS) {
              // console.log("═".repeat(80));
              // console.log("🎬 PROCESO 3D SECURE - FRONTEND");
              // console.log("═".repeat(80));
              // ... logs ...
              // console.log("📦 RESPUESTA COMPLETA DEL BACKEND:", JSON.stringify(res, null, 2));

              const data3DS = res.data3DS as { resultCode?: string; ref_payco?: number; franquicia?: string; '3DS'?: { success: boolean; data: unknown } };

              // Guardar orderId para verificación posterior
              const orderId = res.orderId || "";
              if (orderId) {
                localStorage.setItem('pending_order_id', orderId);
              }

              if (typeof window !== 'undefined' && window.validate3ds) {
                // console.log("🚀 EJECUTANDO window.validate3ds()...");
                try {
                  window.validate3ds(data3DS);
                  // console.log("✅ window.validate3ds() ejecutado correctamente");

                  // RETONAR AQUÍ PARA EVITAR REDIRECCIÓN AUTOMÁTICA
                  // La redirección ocurrirá en el event listener handle3DSMessage
                  return;
                } catch (error) {
                  console.error("❌ [Step7] Error ejecutando validate3ds:", error);
                  setError(`Error ejecutando validación 3DS: ${error}`);
                  setIsProcessing(false);
                  return;
                }
              } else {
                console.error("❌ [Step7] Script de ePayco no cargado");
                setError("Error: Script de validación 3DS no disponible. Por favor recarga la página.");
                setIsProcessing(false);
                return;
              }
            } else {
              console.error("❌ [Step7] requires3DS es true pero falta data3DS");
              setError("Error iniciando seguridad 3D: Datos incompletos del servidor.");
              setIsProcessing(false);
              return;
            }
          }

          // SI NO REQUIERE 3DS, CONTINUAR CON REDIRECCIÓN NORMAL
          localStorage.removeItem('kiosk_client_id');
          router.push(res.redirectionUrl);
          break;
        }
        case "pse": {
          //           console.log("🏦 [Step7] ========== PAGO CON PSE ==========");
          //           console.log("🏦 [Step7] userInfo.direccionId enviado:", checkoutAddress?.id || "");
          //           console.log("🏦 [Step7] userInfo.userId enviado:", authContext.user?.id || String(loggedUser?.id));
          //           console.log("🏦 [Step7] informacion_facturacion.direccion_id enviado:", informacion_facturacion.direccion_id);
          //           console.log("🏦 [Step7] metodo_envio:", metodo_envio);
          //           console.log("🏦 [Step7] codigo_bodega:", codigo_bodega);
          //           console.log("🏦 [Step7] Banco seleccionado:", paymentData.bank, "-", paymentData.bankName);
          //           console.log("🏦 [Step7] ==========================================");

          // Detect kiosk mode for PSE
          const kioskClientPse = (() => {
            try { const kc = localStorage.getItem('kiosk_client_id'); return kc ? JSON.parse(kc) : null; } catch { return null; }
          })();

          const psePaymentData = {
            totalAmount: String(calculations.total),
            shippingAmount: String(calculations.shipping),
            currency: "COP",
            items: products.map((p) => ({
              id: String(p.id),
              sku: String(p.sku),
              name: String(p.name),
              quantity: String(p.quantity),
              unitPrice: String(p.price),
              skupostback: p.skuPostback || p.sku || "",
              desDetallada: p.desDetallada || p.name || "",
              ean: p.ean && p.ean !== "" ? String(p.ean) : String(p.sku),
              category: p.categoria || "",
              ...(p.bundleInfo && {
                bundleInfo: {
                  codCampana: p.bundleInfo.codCampana,
                  productSku: p.bundleInfo.productSku,
                  skusBundle: p.bundleInfo.skusBundle,
                  bundlePrice: p.bundleInfo.bundlePrice,
                  bundleDiscount: p.bundleInfo.bundleDiscount,
                  fechaFinal: p.bundleInfo.fechaFinal,
                },
              }),
            })),
            bank: paymentData.bank || "",
            description: "Pago de pedido en Imagiq",
            metodo_envio,
            codigo_bodega,
            userInfo: {
              direccionId: effectiveAddress?.id || "",
              userId: (() => {
                if (kioskClientPse?.userId) return kioskClientPse.userId;
                return authContext.user?.id || String(loggedUser?.id);
              })(),
            },
            informacion_facturacion,
            beneficios: buildBeneficios(),
            recipientData: recipientPayload,
            bankName: paymentData.bankName || "",
          };

          // Kiosk mode: create pending order and send payment link via email/WhatsApp
          if (kioskClientPse?.email) {
            const kioskRes = await kioskPayWithPse({
              ...psePaymentData,
              kioskCustomerEmail: kioskClientPse.email,
              kioskCustomerPhone: (() => {
                const phone = kioskClientPse.celular || kioskClientPse.telefono || kioskClientPse.phone || "";
                const countryCode = kioskClientPse.codigo_pais || "57";
                if (!phone) return undefined;
                return phone.startsWith(countryCode) ? phone : `${countryCode}${phone}`;
              })(),
              previousOrderId: kioskPaymentLinkSent?.orderId,
              kioskStoreId: authContext.user?.id || loggedUser?.id || "",
              ...getPostHogIds(),
            });
            if ("error" in kioskRes) {
              setError(kioskRes.message);
              throw new Error(kioskRes.message);
            }
            const pseKioskState = {
              email: kioskRes.email,
              orderId: kioskRes.orderId,
              serialId: kioskRes.serialId,
              whatsappSent: kioskRes.kioskWhatsappSent,
              clientData: kioskClientPse,
              // Identidad del flag: permiten descartarlo si la venta siguiente
              // usa otro método, es de otro día o de otro cliente.
              method: 'pse',
              savedAt: Date.now(),
            };
            setKioskPaymentLinkSent(pseKioskState);
            localStorage.setItem('kiosk_payment_link_sent', JSON.stringify(pseKioskState));
            setResendCooldown(60);
            setIsProcessing(false);
            break;
          }

          // Normal flow: redirect to bank
          const res = await payWithPse(psePaymentData);
          if ("error" in res) {
            setError(res.message);
            throw new Error(res.message);
          }
          localStorage.removeItem('kiosk_client_id');
          router.push(res.redirectUrl);
          break;
        }
        case "addi": {
          //           console.log("💰 [Step7] ========== PAGO CON ADDI ==========");
          //           console.log("💰 [Step7] userInfo.direccionId enviado:", checkoutAddress?.id || "");
          //           console.log("💰 [Step7] userInfo.userId enviado:", authContext.user?.id || String(loggedUser?.id));
          //           console.log("💰 [Step7] informacion_facturacion.direccion_id enviado:", informacion_facturacion.direccion_id);
          //           console.log("💰 [Step7] metodo_envio:", metodo_envio);
          //           console.log("💰 [Step7] codigo_bodega:", codigo_bodega);
          //           console.log("💰 [Step7] ==========================================");

          // Detect kiosk mode for Addi
          const kioskClientAddi = (() => {
            try { const kc = localStorage.getItem('kiosk_client_id'); return kc ? JSON.parse(kc) : null; } catch { return null; }
          })();

          const addiPaymentData = {
            totalAmount: String(calculations.total),
            shippingAmount: String(calculations.shipping),
            currency: "COP",
            items: products.map((p) => ({
              id: String(p.id),
              sku: String(p.sku),
              name: String(p.name),
              quantity: String(p.quantity),
              unitPrice: String(p.price),
              skupostback: p.skuPostback || p.sku || "",
              desDetallada: p.desDetallada || p.name || "",
              ean: p.ean && p.ean !== "" ? String(p.ean) : String(p.sku),
              category: p.categoria || "",
              ...(p.bundleInfo && {
                bundleInfo: {
                  codCampana: p.bundleInfo.codCampana,
                  productSku: p.bundleInfo.productSku,
                  skusBundle: p.bundleInfo.skusBundle,
                  bundlePrice: p.bundleInfo.bundlePrice,
                  bundleDiscount: p.bundleInfo.bundleDiscount,
                  fechaFinal: p.bundleInfo.fechaFinal,
                },
              }),
            })),
            metodo_envio,
            codigo_bodega,
            userInfo: {
              direccionId: effectiveAddress?.id || "",
              userId: (() => {
                if (kioskClientAddi?.userId) return kioskClientAddi.userId;
                return authContext.user?.id || String(loggedUser?.id);
              })(),
            },
            informacion_facturacion,
            beneficios: buildBeneficios(),
            recipientData: recipientPayload,
          };

          // Kiosk mode: use separate endpoint that sends link via email
          if (kioskClientAddi?.email) {
            const kioskRes = await kioskPayWithAddi({
              ...addiPaymentData,
              kioskCustomerEmail: kioskClientAddi.email,
              kioskCustomerPhone: (() => {
                const phone = kioskClientAddi.celular || kioskClientAddi.telefono || kioskClientAddi.phone || "";
                const countryCode = kioskClientAddi.codigo_pais || "57";
                if (!phone) return undefined;
                return phone.startsWith(countryCode) ? phone : `${countryCode}${phone}`;
              })(),
              previousOrderId: kioskPaymentLinkSent?.orderId,
              kioskStoreId: authContext.user?.id || loggedUser?.id || "",
              ...getPostHogIds(),
            });
            if ("error" in kioskRes) {
              setError(kioskRes.message);
              throw new Error(kioskRes.message);
            }
            const addiKioskState = {
              email: kioskRes.email,
              orderId: kioskRes.orderId,
              serialId: kioskRes.serialId,
              whatsappSent: kioskRes.kioskWhatsappSent,
              clientData: kioskClientAddi,
              // Identidad del flag (ver comentario en el estado inicial).
              method: 'addi',
              savedAt: Date.now(),
            };
            setKioskPaymentLinkSent(addiKioskState);
            localStorage.setItem('kiosk_payment_link_sent', JSON.stringify(addiKioskState));
            setResendCooldown(60);
            setIsProcessing(false);
            break;
          }

          // Normal flow: redirect to Addi
          const res = await payWithAddi(addiPaymentData);
          if ("error" in res) {
            setError(res.message);
            throw new Error(res.message);
          }
          localStorage.removeItem('kiosk_client_id');
          router.push(res.redirectUrl);
          break;
        }
        case "datafono_efectivo": {
          // Datafono/Efectivo: crear orden sin datos de pago y postear a Novasol
          const kioskClientDatafono = (() => {
            try { const kc = localStorage.getItem('kiosk_client_id'); return kc ? JSON.parse(kc) : null; } catch { return null; }
          })();

          const datafonoPayload = {
            totalAmount: String(calculations.total),
            shippingAmount: String(calculations.shipping),
            currency: "COP",
            items: products.map((p) => ({
              id: String(p.id),
              sku: String(p.sku),
              name: String(p.name),
              quantity: String(p.quantity),
              unitPrice: String(p.price),
              skupostback: p.skuPostback || p.sku || "",
              desDetallada: p.desDetallada || p.name || "",
              ean: p.ean && p.ean !== "" ? String(p.ean) : String(p.sku),
              category: p.categoria || "",
              ...(p.bundleInfo && {
                bundleInfo: {
                  codCampana: p.bundleInfo.codCampana,
                  productSku: p.bundleInfo.productSku,
                  skusBundle: p.bundleInfo.skusBundle,
                  bundlePrice: p.bundleInfo.bundlePrice,
                  bundleDiscount: p.bundleInfo.bundleDiscount,
                  fechaFinal: p.bundleInfo.fechaFinal,
                },
              }),
            })),
            metodo_envio,
            codigo_bodega,
            userInfo: {
              direccionId: effectiveAddress?.id || "",
              userId: (() => {
                if (kioskClientDatafono?.userId) return kioskClientDatafono.userId;
                return authContext.user?.id || String(loggedUser?.id);
              })(),
            },
            informacion_facturacion,
            beneficios: buildBeneficios(),
            recipientData: recipientPayload,
            kioskStoreId: authContext.user?.id || loggedUser?.id || "",
            ...getPostHogIds(),
          };

          console.log("🏪 [Step7] Creando orden Datafono/Efectivo...");
          const datafonoRes = await kioskCreateDatafonoOrder(datafonoPayload);

          if ("error" in datafonoRes) {
            setError(datafonoRes.message);
            throw new Error(datafonoRes.message);
          }

          console.log("✅ [Step7] Orden Datafono creada:", datafonoRes.orderId, "Novasol:", datafonoRes.novasoftPosted);
          setDatafonoOrderId(datafonoRes.orderId);
          setDatafonoOrderCreated(true);
          setIsProcessing(false);
          toast.success(`Orden posteada a Novasol exitosamente`);
          break;
        }
        default:
          throw new Error("Método de pago no soportado");
      }
      // Redirigir a página de éxito
    } catch (error) {
      console.error("Error processing payment:", error);
      setIsProcessing(false);
      throw error; // Re-throw so callers (like resend) can handle it
    }
  };

  // Función que verifica si es usuario invitado y muestra el modal
  const handleConfirmOrder = async () => {
    try {
      // console.log("🔍 [STEP7] ========== handleConfirmOrder INICIADO ==========");

      // CRÍTICO: Priorizar authContext.user (datos frescos después de login) sobre loggedUser (puede estar cacheado)
      let userRole: number | undefined;
      let user: any;

      // 1. Intentar obtener de authContext primero (más confiable después de login)
      if (authContext?.user) {
        user = authContext.user;
        userRole = user.rol ?? user.role;
        //         console.log("✅ [STEP7] Usuario detectado desde authContext (DATOS FRESCOS):", {
        // id: user.id,
        // email: user.email,
        // rol: user.rol,
        // role: user.role,
        // finalRole: userRole,
        // tieneContrasena: !!(user.contrasena || user.password)
        // });
      }
      // 2. Fallback a loggedUser si authContext no tiene usuario
      else if (loggedUser) {
        user = loggedUser as any;
        userRole = user.rol ?? user.role;
        //         console.log("⚠️ [STEP7] Usuario detectado desde loggedUser (FALLBACK):", {
        // id: user.id,
        // email: user.email,
        // rol: user.rol,
        // role: user.role,
        // finalRole: userRole,
        // tieneContrasena: !!(user.contrasena || user.password)
        // });
      } else {
        console.warn("❌ [STEP7] No se encontró usuario en authContext ni en loggedUser");
      }

      // Verificar si tiene contraseña (usuario verdadero invitado sin contraseña)
      const hasPassword = user?.contrasena || user?.password;
      const isGuestWithoutPassword = userRole === 3 && !hasPassword;

      // console.log("🔍 [STEP7] Verificando usuario para modal:", {
      // rol: userRole,
      // tieneContrasena: !!hasPassword,
      // esInvitadoSinContrasena: isGuestWithoutPassword,
      // showPasswordModal: showPasswordModal
      // });

      // Si es usuario invitado (rol 3) SIN contraseña, mostrar modal de registro
      if (isGuestWithoutPassword) {
        //         console.log("✅ [STEP7] ========== USUARIO INVITADO SIN CONTRASEÑA DETECTADO ==========");
        //         console.log("✅ [STEP7] Activando modal de registro...");
        setShowPasswordModal(true);
        setPendingOrder(true);
        //         console.log("✅ [STEP7] Estados actualizados:");
        //         console.log("  - showPasswordModal: true");
        //         console.log("  - pendingOrder: true");
        //         console.log("✅ [STEP7] ================================================");
        return;
      }

      // Si no es invitado, procesar la orden directamente
      //       console.log("✅ [STEP7] Usuario regular (rol:", userRole, "), procesando orden directamente");
      await processOrder();
    } catch (error) {
      console.error("❌ [STEP7] ERROR en handleConfirmOrder:", error);
    }
  };

  // Callback cuando el usuario se registra exitosamente
  const handleRegisterSuccess = async () => {
    //     console.log("✅ [STEP7] handleRegisterSuccess ejecutado - Cerrando modal y procesando orden");
    setShowPasswordModal(false);
    setPendingOrder(false);

    // Procesar la orden después de registrarse (sin delay, processOrder maneja isProcessing)
    //     console.log("🔄 [STEP7] Iniciando processOrder después del registro exitoso");
    try {
      await processOrder();
    } catch (error) {
      console.error("❌ [STEP7] ERROR en handleRegisterSuccess:", error);
    }
  };

  // Callback cuando el usuario cancela el modal
  const handleModalClose = async () => {
    // console.log("🔍 [STEP7] handleModalClose ejecutado - Usuario continúa como invitado");
    setShowPasswordModal(false);
    setPendingOrder(false);

    // Procesar la orden como invitado (sin delay, processOrder maneja isProcessing)
    //     console.log("🔄 [STEP7] Procesando orden como invitado");
    try {
      await processOrder();
    } catch (error) {
      console.error("❌ [STEP7] ERROR en handleModalClose:", error);
    }
  };

  const getPaymentMethodLabel = (method: string) => {
    switch (method) {
      case "tarjeta":
        return isKioskMode ? "Tarjeta (crédito - débito) o efectivo" : "Tarjeta de crédito/débito";
      case "pse":
        return "PSE - Pago Seguro en Línea";
      case "addi":
        return "Paga a cuotas con Addi";
      case "datafono_efectivo":
        return "Datafono / Efectivo";
      default:
        return method;
    }
  };

  // Verificar si las cuotas seleccionadas son elegibles para cero interés
  const isInstallmentEligibleForZeroInterest = (
    installments: number,
    cardId: string
  ): boolean => {
    if (!zeroInterestData?.cards) return false;

    const cardInfo = zeroInterestData.cards.find((c) => c.id === cardId);
    if (!cardInfo?.eligibleForZeroInterest) return false;

    return cardInfo.availableInstallments.includes(installments);
  };

  // Kiosk: handler to finalize order and go home
  const handleKioskFinalize = () => {
    // Clean all checkout localStorage keys
    localStorage.removeItem('kiosk_client_id');
    localStorage.removeItem('kiosk_client');
    localStorage.removeItem('checkout-address');
    localStorage.removeItem('imagiq_default_address');
    localStorage.removeItem('imagiq_candidate_stores_cache');
    localStorage.removeItem('checkout-billing-data');
    localStorage.removeItem('checkout-envio-imagiq');
    localStorage.removeItem('checkout-received-by-client');
    localStorage.removeItem('checkout-zero-interest');
    localStorage.removeItem('checkout-delivery-method');
    localStorage.removeItem('checkout-payment-method');
    localStorage.removeItem('checkout-selected-bank');
    localStorage.removeItem('checkout-installments');
    localStorage.removeItem('checkout-card-data');
    localStorage.removeItem('checkout-saved-card-id');
    localStorage.removeItem('kiosk_payment_link_sent');
    localStorage.removeItem('pending_order_id');
    // Clear the cart
    clearCart();
    router.push('/');
  };

  // Kiosk: handler to resend payment link (calls kiosk endpoint directly)
  const handleKioskResendLink = async () => {
    if (isResending || resendCooldown > 0 || !paymentData) return;
    setIsResending(true);
    try {
      const kioskClient = (() => {
        try { const kc = localStorage.getItem('kiosk_client_id'); return kc ? JSON.parse(kc) : null; } catch { return null; }
      })();
      if (!kioskClient?.email) {
        toast.error("No se encontraron datos del cliente");
        return;
      }

      const kioskPhone = (() => {
        const phone = kioskClient.celular || kioskClient.telefono || kioskClient.phone || "";
        const countryCode = kioskClient.codigo_pais || "57";
        if (!phone) return undefined;
        return phone.startsWith(countryCode) ? phone : `${countryCode}${phone}`;
      })();

      // Re-run processOrder which will create a new order and send the link
      await processOrder();

      // Check if it succeeded (processOrder swallows errors internally)
      // Show success toast - if processOrder failed, the error state will be set
      if (!error) {
        toast.success("Link de pago reenviado exitosamente");
        setResendCooldown(60);
      } else {
        toast.error("Error al reenviar el link de pago");
      }
    } catch (err) {
      toast.error("Error al reenviar el link de pago");
    } finally {
      setIsResending(false);
    }
  };

  // Datafono/Efectivo: confirmar que el pago se realizó en el datafono/efectivo
  const handleDatafonoConfirm = async () => {
    if (!datafonoOrderId || isConfirmingDatafono) return;
    setIsConfirmingDatafono(true);
    setError(null);
    try {
      console.log("🏪 [Step7] Confirmando pago Datafono/Efectivo para orden:", datafonoOrderId);
      const res = await kioskConfirmDatafono(datafonoOrderId);

      if ("error" in res) {
        setError(res.message);
        toast.error(res.message);
        return;
      }

      console.log("✅ [Step7] Orden Datafono confirmada:", res);
      setDatafonoConfirmed(true);
      toast.success("Compra confirmada exitosamente");
    } catch (err) {
      console.error("❌ [Step7] Error confirmando datafono:", err);
      const msg = err instanceof Error ? err.message : "Error al confirmar la compra";
      setError(msg);
      toast.error(msg);
    } finally {
      setIsConfirmingDatafono(false);
    }
  };

  const handleOrderApprovedContinue = () => {
    localStorage.removeItem('kiosk_payment_link_sent');
    localStorage.removeItem('pending_order_id');
    clearCart();
    router.push('/');
  };

  return (
    <>
      {/* Modal de Datafono/Efectivo confirmado */}
      {datafonoConfirmed && (
        <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/60">
          <div className="bg-white rounded-2xl p-10 max-w-md w-full mx-4 text-center shadow-2xl">
            <div className="mx-auto w-20 h-20 bg-green-100 rounded-full flex items-center justify-center mb-6">
              <svg className="w-10 h-10 text-green-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
              </svg>
            </div>
            <h2 className="text-2xl font-bold text-gray-900 mb-2">Compra confirmada</h2>
            <p className="text-gray-600 mb-2">El pago ha sido registrado exitosamente.</p>
            <p className="text-sm text-gray-500 mb-6">Pedido N° {datafonoSerialId || datafonoOrderId}</p>
            <button
              onClick={handleKioskFinalize}
              className="w-full bg-black text-white font-bold py-3 px-6 rounded-xl text-lg hover:bg-gray-800 transition-colors"
            >
              Volver al inicio
            </button>
          </div>
        </div>
      )}

      {/* Modal de pago confirmado via WebSocket */}
      {showOrderApprovedModal && (
        <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/60">
          <div className="bg-white rounded-2xl p-10 max-w-md w-full mx-4 text-center shadow-2xl">
            <div className="mx-auto w-20 h-20 bg-green-100 rounded-full flex items-center justify-center mb-6">
              <svg className="w-10 h-10 text-green-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
              </svg>
            </div>
            <h2 className="text-2xl font-bold text-gray-900 mb-2">¡Pago confirmado!</h2>
            <p className="text-gray-600 mb-4">El cliente completó el pago exitosamente.</p>
            {kioskPaymentLinkSent?.serialId && (
              <div className="bg-green-50 border-2 border-green-300 rounded-lg p-4 mb-6">
                <p className="text-xs text-green-700 font-medium">N° de orden</p>
                <p className="text-2xl font-bold text-green-900 tracking-wide">
                  {kioskPaymentLinkSent.serialId}
                </p>
              </div>
            )}
            <button
              onClick={handleOrderApprovedContinue}
              className="w-full bg-black text-white font-bold py-3 px-6 rounded-xl text-lg hover:bg-gray-800 transition-colors"
            >
              Continuar
            </button>
          </div>
        </div>
      )}

    <div className="min-h-screen w-full pb-40 md:pb-0">
      <div className="w-full max-w-7xl mx-auto px-4 py-6">
        <div className="mb-6">
          {isLoadingCanPickUp ? (
            <div className="animate-pulse">
              <div className="h-8 w-64 bg-gray-200 rounded mb-2"></div>
              <div className="h-5 w-96 bg-gray-200 rounded"></div>
            </div>
          ) : (
            <>
              <h1 className="text-2xl font-bold text-gray-900 inline">
                Confirma tu pedido
              </h1>
              <p className="text-gray-600 inline ml-2">
                Revisa todos los detalles antes de confirmar tu compra
              </p>
            </>
          )}
        </div>

        {/* Banner de estado Datafono/Efectivo (legacy) */}
        {paymentData?.method === "datafono_efectivo" && datafonoOrderCreated && !datafonoConfirmed && (
          <div className="bg-amber-50 border-2 border-amber-300 rounded-lg p-4 mb-4">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 bg-amber-100 rounded-full flex items-center justify-center shrink-0">
                <CreditCard className="w-5 h-5 text-amber-700" />
              </div>
              <div>
                <p className="font-semibold text-amber-900">Orden posteada a Novasol</p>
                <p className="text-sm text-amber-700">
                  Orden: <span className="font-mono font-bold">{datafonoOrderId}</span>
                </p>
                <p className="text-sm text-amber-700 mt-1">
                  Procesa el pago en el datafono o efectivo y luego presiona &quot;Confirmar compra&quot;.
                </p>
              </div>
            </div>
          </div>
        )}

        {/* Banner Kiosk Tarjeta/Datafono: ya no se necesita aquí, se usa la página completa (early return arriba) */}

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          {/* Sección de resumen */}
          <div className="lg:col-span-2 space-y-4 lg:min-h-[70vh]">
            {isLoadingCanPickUp ? (
              /* Skeleton de toda la sección mientras carga */
              <>
                {/* Skeleton Método de pago */}
                <div className="bg-white rounded-lg p-4 border border-gray-300 animate-pulse">
                  <div className="flex items-center justify-between mb-4">
                    <div className="flex items-center gap-3">
                      <div className="w-10 h-10 bg-gray-200 rounded-full"></div>
                      <div className="space-y-2">
                        <div className="h-5 w-32 bg-gray-200 rounded"></div>
                        <div className="h-4 w-48 bg-gray-200 rounded"></div>
                      </div>
                    </div>
                    <div className="h-8 w-20 bg-gray-200 rounded"></div>
                  </div>
                  <div className="space-y-3">
                    <div className="h-20 bg-gray-100 rounded-lg"></div>
                  </div>
                </div>

                {/* Skeleton Método de entrega */}
                <div className="bg-white rounded-lg p-4 border border-gray-300 animate-pulse">
                  <div className="flex items-center justify-between mb-4">
                    <div className="flex items-center gap-3">
                      <div className="w-10 h-10 bg-gray-200 rounded-full"></div>
                      <div className="space-y-2">
                        <div className="h-5 w-32 bg-gray-200 rounded"></div>
                        <div className="h-4 w-40 bg-gray-200 rounded"></div>
                      </div>
                    </div>
                    <div className="h-8 w-20 bg-gray-200 rounded"></div>
                  </div>
                  <div className="h-16 bg-gray-100 rounded-lg"></div>
                </div>

                {/* Skeleton Información del receptor */}
                <div className="bg-white rounded-lg p-4 border border-gray-300 animate-pulse">
                  <div className="flex items-center justify-between mb-4">
                    <div className="flex items-center gap-3">
                      <div className="w-10 h-10 bg-gray-200 rounded-full"></div>
                      <div className="space-y-2">
                        <div className="h-5 w-40 bg-gray-200 rounded"></div>
                        <div className="h-4 w-48 bg-gray-200 rounded"></div>
                      </div>
                    </div>
                    <div className="h-8 w-20 bg-gray-200 rounded"></div>
                  </div>
                </div>

                {/* Skeleton Datos de facturación */}
                <div className="bg-white rounded-lg p-4 border border-gray-300 animate-pulse">
                  <div className="flex items-center justify-between mb-4">
                    <div className="flex items-center gap-3">
                      <div className="w-10 h-10 bg-gray-200 rounded-full"></div>
                      <div className="space-y-2">
                        <div className="h-5 w-32 bg-gray-200 rounded"></div>
                        <div className="h-4 w-32 bg-gray-200 rounded"></div>
                      </div>
                    </div>
                    <div className="h-8 w-20 bg-gray-200 rounded"></div>
                  </div>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div className="space-y-2">
                      <div className="h-3 w-16 bg-gray-200 rounded"></div>
                      <div className="h-4 w-full bg-gray-200 rounded"></div>
                    </div>
                    <div className="space-y-2">
                      <div className="h-3 w-16 bg-gray-200 rounded"></div>
                      <div className="h-4 w-full bg-gray-200 rounded"></div>
                    </div>
                    <div className="space-y-2">
                      <div className="h-3 w-16 bg-gray-200 rounded"></div>
                      <div className="h-4 w-full bg-gray-200 rounded"></div>
                    </div>
                    <div className="space-y-2">
                      <div className="h-3 w-16 bg-gray-200 rounded"></div>
                      <div className="h-4 w-full bg-gray-200 rounded"></div>
                    </div>
                  </div>
                </div>
              </>
            ) : (
              <>
                {/* Fila 1: Método de pago e Información del receptor */}
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                  {/* Método de pago */}
                  {paymentData && (
                    <div className="bg-white rounded-lg p-4 border border-gray-300">
                      <div className="flex items-center justify-between mb-4">
                        <div className="flex items-center gap-3">
                          <div className="w-10 h-10 bg-gray-100 rounded-full flex items-center justify-center">
                            <CreditCard className="w-5 h-5 text-gray-600" />
                          </div>
                          <div>
                            <h2 className="text-lg font-bold text-gray-900">
                              Método de pago
                            </h2>
                            <p className="text-sm text-gray-600">
                              {getPaymentMethodLabel(paymentData.method)}
                            </p>
                          </div>
                        </div>
                        <button
                          type="button"
                          onClick={() => router.push("/carrito/step4")}
                          className="text-blue-600 hover:text-blue-700 text-sm font-medium flex items-center gap-1"
                        >
                          <Edit2 className="w-4 h-4" />
                          Editar
                        </button>
                      </div>

                      <div className="space-y-3">
                        {paymentData.method === "tarjeta" && (
                          <>
                            {/* Mostrar detalles de tarjeta guardada */}
                            {paymentData.savedCard && (
                              <div className="flex items-start gap-3 p-3 bg-gray-50 rounded-lg">
                                <div className="flex flex-col items-start gap-1 min-w-[60px]">
                                  <CardBrandLogo
                                    brand={paymentData.savedCard.marca}
                                    size="md"
                                  />
                                  {paymentData.savedCard.nombre_titular && (
                                    <span className="text-[10px] text-gray-500 uppercase leading-tight">
                                      {paymentData.savedCard.nombre_titular}
                                    </span>
                                  )}
                                </div>
                                <div className="flex-1 flex flex-col justify-center">
                                  <div className="flex items-center gap-4 mb-1">
                                    <span className="font-semibold text-gray-900 tracking-wider">
                                      •••• {paymentData.savedCard.ultimos_dijitos}
                                    </span>
                                    {paymentData.savedCard.tipo_tarjeta && (
                                      <span className="text-xs text-gray-500 uppercase">
                                        {paymentData.savedCard.tipo_tarjeta
                                          .toUpperCase()
                                          .includes("CREDIT")
                                          ? "Crédito"
                                          : "Débito"}
                                      </span>
                                    )}
                                  </div>
                                  <div className="flex justify-between items-center text-xs text-gray-600 w-full">
                                    {paymentData.savedCard.banco ? (
                                      <span>{paymentData.savedCard.banco}</span>
                                    ) : <span></span>}

                                    {paymentData.installments && (
                                      <div className="flex items-center gap-1">
                                        <span className="text-gray-500">Cuotas:</span>
                                        <span className="font-medium text-gray-900">
                                          {paymentData.installments}x
                                          {paymentData.savedCard &&
                                            isInstallmentEligibleForZeroInterest(
                                              paymentData.installments,
                                              String(paymentData.savedCard.id)
                                            ) && (
                                              <span className="ml-1 text-green-600 font-semibold">
                                                (0%)
                                              </span>
                                            )}
                                        </span>
                                      </div>
                                    )}
                                  </div>
                                </div>
                              </div>
                            )}
                            {/* Mostrar detalles de tarjeta nueva */}
                            {paymentData.cardData && (
                              <div className="flex items-start gap-3 p-3 bg-gray-50 rounded-lg">
                                <div className="flex flex-col items-start gap-1 min-w-[60px]">
                                  {paymentData.cardData.brand && (
                                    <CardBrandLogo
                                      brand={paymentData.cardData.brand}
                                      size="md"
                                    />
                                  )}
                                  {paymentData.cardData.cardHolder && (
                                    <span className="text-[10px] text-gray-500 uppercase leading-tight">
                                      {paymentData.cardData.cardHolder}
                                    </span>
                                  )}
                                </div>
                                <div className="flex-1 flex flex-col justify-center">
                                  <div className="flex items-center gap-4 mb-1">
                                    <span className="font-semibold text-gray-900 tracking-wider">
                                      ••••{" "}
                                      {paymentData.cardData.cardNumber.slice(-4)}
                                    </span>
                                    {paymentData.cardData.cardType && (
                                      <span className="text-xs text-gray-500 uppercase">
                                        {paymentData.cardData.cardType
                                          .toUpperCase()
                                          .includes("CREDIT")
                                          ? "Crédito"
                                          : "Débito"}
                                      </span>
                                    )}
                                  </div>
                                  <div className="flex justify-between items-center text-xs text-gray-600 w-full">
                                    {paymentData.cardData.bank ? (
                                      <span>{paymentData.cardData.bank}</span>
                                    ) : <span></span>}

                                    {paymentData.installments && (
                                      <div className="flex items-center gap-1">
                                        <span className="text-gray-500">Cuotas:</span>
                                        <span className="font-medium text-gray-900">
                                          {paymentData.installments}x
                                          {(() => {
                                            // Para tarjetas nuevas, intentar obtener el ID de localStorage
                                            const savedCardId = localStorage.getItem(
                                              "checkout-saved-card-id"
                                            );
                                            return (
                                              savedCardId &&
                                              isInstallmentEligibleForZeroInterest(
                                                paymentData.installments,
                                                savedCardId
                                              ) && (
                                                <span className="ml-1 text-green-600 font-semibold">
                                                  (0%)
                                                </span>
                                              )
                                            );
                                          })()}
                                        </span>
                                      </div>
                                    )}
                                  </div>
                                </div>
                              </div>
                            )}
                          </>
                        )}
                        {paymentData.method === "pse" && paymentData.bank && (
                          <div className="flex justify-between text-sm">
                            <span className="text-gray-600">Banco:</span>
                            <span className="font-medium text-gray-900">
                              {paymentData.bankName || paymentData.bank}
                            </span>
                          </div>
                        )}
                      </div>
                    </div>
                  )}

                  {/* Información del receptor */}
                  {recipientData && (
                    <div className="bg-white rounded-lg p-4 border border-gray-300">
                      <div className="flex items-center justify-between mb-4">
                        <div className="flex items-center gap-3">
                          <div className="w-10 h-10 bg-gray-100 rounded-full flex items-center justify-center">
                            <UserIcon className="w-5 h-5 text-gray-600" />
                          </div>
                          <div>
                            <h2 className="text-lg font-bold text-gray-900">
                              Información del receptor
                            </h2>
                            <p className="text-sm text-gray-600">
                              {recipientData.receivedByClient
                                ? "Será recibido por el cliente"
                                : "Será recibido por otra persona"}
                            </p>
                          </div>
                        </div>
                        <button
                          type="button"
                          onClick={() => router.push("/carrito/step3")}
                          className="text-blue-600 hover:text-blue-700 text-sm font-medium flex items-center gap-1"
                        >
                          <Edit2 className="w-4 h-4" />
                          Editar
                        </button>
                      </div>

                      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        {/* Nombre */}
                        <div>
                          <p className="text-xs text-gray-500 mb-1">Nombre</p>
                          <p className="text-sm font-medium text-gray-900">
                            {recipientData.firstName || "-"}
                          </p>
                        </div>

                        {/* Apellido */}
                        <div>
                          <p className="text-xs text-gray-500 mb-1">Apellido</p>
                          <p className="text-sm font-medium text-gray-900">
                            {recipientData.lastName || "-"}
                          </p>
                        </div>

                        {/* Email */}
                        <div className="overflow-hidden">
                          <p className="text-xs text-gray-500 mb-1">
                            Correo electrónico
                          </p>
                          <p
                            className="text-sm font-medium text-gray-900 truncate"
                            title={recipientData.email || ""}
                          >
                            {recipientData.email || "-"}
                          </p>
                        </div>

                        {/* Teléfono */}
                        <div>
                          <p className="text-xs text-gray-500 mb-1">
                            Número de celular
                          </p>
                          <p className="text-sm font-medium text-gray-900">
                            {recipientData.phone || "-"}
                          </p>
                        </div>
                      </div>
                    </div>
                  )}
                </div>

                {/* Método de entrega */}
                {shippingData && (
                  <div className="bg-white rounded-lg p-4 border border-gray-300">
                    <div className="flex items-start justify-between">
                      <div className="flex items-start gap-3 w-full">
                        <div className="w-10 h-10 bg-gray-100 rounded-full flex items-center justify-center flex-shrink-0">
                          {shippingData.type === "delivery" ? (
                            <Truck className="w-5 h-5 text-gray-600" />
                          ) : (
                            <Store className="w-5 h-5 text-gray-600" />
                          )}
                        </div>

                        <div className="flex-1 grid grid-cols-1 md:grid-cols-2 gap-x-4 gap-y-2">
                          {/* Columna Izquierda: Título */}
                          <div>
                            <h2 className="text-lg font-bold text-gray-900">
                              Método de entrega
                            </h2>
                            <p className="text-sm text-gray-600">
                              {shippingData.type === "delivery"
                                ? "Envío a domicilio"
                                : "Recogida en tienda"}
                            </p>
                          </div>

                          {/* Columna Derecha: Detalles */}
                          <div className="text-sm">
                            {shippingData.type === "delivery" ? (
                              <div className="flex flex-col text-gray-700">
                                <span className="font-medium text-gray-900 break-words">
                                  {shippingData.address}
                                </span>
                                <div className="flex flex-col text-xs text-gray-600 mt-1">
                                  {shippingData.city && (
                                    <span>{shippingData.city}</span>
                                  )}
                                  {checkoutAddress?.pais && (
                                    <span>{checkoutAddress.pais}</span>
                                  )}
                                </div>
                              </div>
                            ) : (
                              <div className="flex flex-col text-gray-700">
                                <span className="font-medium text-gray-900">
                                  {shippingData.store?.name || "Recoger en tienda"}
                                </span>
                                {shippingData.store?.address && (
                                  <span className="text-xs text-gray-600 mt-1">{shippingData.store.address}</span>
                                )}
                                {shippingData.store?.city && (
                                  <span className="text-xs text-gray-500">{shippingData.store.city}</span>
                                )}
                                {shippingData.store?.schedule && (
                                  <span className="text-xs text-gray-500 mt-1">
                                    Horario: {shippingData.store.schedule}
                                  </span>
                                )}
                              </div>
                            )}
                          </div>
                        </div>
                      </div>

                      <button
                        type="button"
                        onClick={() => router.push("/carrito/step3")}
                        className="text-blue-600 hover:text-blue-700 text-sm font-medium flex items-center gap-1 ml-4 flex-shrink-0"
                      >
                        <Edit2 className="w-4 h-4" />
                        Editar
                      </button>
                    </div>
                  </div>
                )}

                {/* Datos de facturación */}
                {billingData && (
                  <div className="bg-white rounded-lg p-4 border border-gray-300">
                    <div className="flex items-center justify-between mb-4">
                      <div className="flex items-center gap-3">
                        <div className="w-10 h-10 bg-gray-100 rounded-full flex items-center justify-center">
                          <FileText className="w-5 h-5 text-gray-600" />
                        </div>
                        <div>
                          <h2 className="text-lg font-bold text-gray-900">
                            Datos de facturación
                          </h2>
                          <p className="text-sm text-gray-600">
                            {billingData.type === "natural"
                              ? "Persona Natural"
                              : "Persona Jurídica"}
                          </p>
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={() => router.push("/carrito/step6")}
                        className="text-blue-600 hover:text-blue-700 text-sm font-medium flex items-center gap-1"
                      >
                        <Edit2 className="w-4 h-4" />
                        Editar
                      </button>
                    </div>

                    <div className="space-y-4">
                      {/* Razón Social (solo para jurídica) - ocupa todo el ancho */}
                      {billingData.type === "juridica" &&
                        billingData.razonSocial && (
                          <div>
                            <p className="text-xs text-gray-500 mb-1">
                              Razón Social
                            </p>
                            <p className="text-sm font-medium text-gray-900">
                              {billingData.razonSocial}
                            </p>
                          </div>
                        )}

                      {/* Grid de 2 columnas para los demás campos */}
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        {/* NIT (solo para jurídica) */}
                        {billingData.type === "juridica" && billingData.nit && (
                          <div>
                            <p className="text-xs text-gray-500 mb-1">NIT</p>
                            <p className="text-sm font-medium text-gray-900">
                              {billingData.nit}
                            </p>
                          </div>
                        )}

                        {/* Nombre */}
                        <div>
                          <p className="text-xs text-gray-500 mb-1">Nombre</p>
                          <p className="text-sm font-medium text-gray-900">
                            {billingData.nombre}
                          </p>
                        </div>

                        {/* Documento */}
                        <div>
                          <p className="text-xs text-gray-500 mb-1">Documento</p>
                          <p className="text-sm font-medium text-gray-900">
                            {billingData.documento}
                          </p>
                        </div>

                        {/* Email */}
                        <div>
                          <p className="text-xs text-gray-500 mb-1">Email</p>
                          <p className="text-sm font-medium text-gray-900">
                            {billingData.email}
                          </p>
                        </div>

                        {/* Teléfono */}
                        <div>
                          <p className="text-xs text-gray-500 mb-1">Teléfono</p>
                          <p className="text-sm font-medium text-gray-900">
                            {billingData.telefono}
                          </p>
                        </div>
                      </div>

                      {/* Dirección de facturación - ocupa todo el ancho */}
                      {billingData.direccion && (
                        <div>
                          <p className="text-xs text-gray-500 mb-1">
                            Dirección de facturación
                          </p>
                          <div className="flex items-start gap-4 p-3 bg-gray-50 rounded-lg">
                            <MapPin className="w-4 h-4 text-gray-400 flex-shrink-0 mt-0.5" />
                            <div>
                              <p className="text-sm font-medium text-gray-900">
                                {billingData.direccion.linea_uno}
                              </p>
                              {billingData.direccion.ciudad && (
                                <p className="text-xs text-gray-600 mt-1">
                                  {billingData.direccion.ciudad}
                                </p>
                              )}
                            </div>
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                )}

                {/* Detalle de productos del carrito */}
                <div className="bg-white rounded-lg p-4 border border-gray-300">
                  <div className="flex items-center gap-3 mb-4">
                    <div className="w-10 h-10 bg-gray-100 rounded-full flex items-center justify-center">
                      <Package className="w-5 h-5 text-gray-600" />
                    </div>
                    <div>
                      <h2 className="text-lg font-bold text-gray-900">
                        Detalle de compra
                      </h2>
                      <p className="text-sm text-gray-600">
                        {products.reduce((acc, p) => acc + p.quantity, 0)} producto{products.reduce((acc, p) => acc + p.quantity, 0) !== 1 ? "s" : ""}
                      </p>
                    </div>
                  </div>
                  <div className="space-y-3">
                    {products.map((product, index) => (
                      <div key={`${product.sku ?? product.id}-${index}`} className="flex items-center gap-3 p-3 bg-gray-50 rounded-lg">
                        <div className="relative w-20 h-20 flex-shrink-0 bg-white rounded-lg overflow-hidden border border-gray-200">
                          {product.image ? (
                            <Image
                              src={product.image}
                              alt={product.name}
                              fill
                              className="object-contain p-1"
                              sizes="80px"
                            />
                          ) : (
                            <div className="w-full h-full flex items-center justify-center">
                              <Package className="w-6 h-6 text-gray-300" />
                            </div>
                          )}
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-medium text-gray-900 truncate">{product.displayName || product.desDetallada || product.name}</p>
                          <p className="text-xs text-gray-500">Cant: {product.quantity}</p>
                        </div>
                        <p className="text-sm font-bold text-gray-900 flex-shrink-0">
                          $ {Number(product.price * product.quantity).toLocaleString()}
                        </p>
                      </div>
                    ))}
                  </div>
                </div>
              </>
            )}
          </div>

          {/* Resumen de compra y Trade-In - Hidden en mobile */}
          <aside className="hidden md:block lg:col-span-1 space-y-4 self-start sticky top-40">
            {isLoadingCanPickUp ? (
              /* Skeleton del resumen mientras carga */
              <div className="bg-white rounded-2xl p-4 shadow border border-[#E5E5E5] animate-pulse">
                <div className="space-y-4">
                  {/* Título */}
                  <div className="h-6 w-40 bg-gray-200 rounded"></div>

                  {/* Líneas de precios */}
                  <div className="space-y-3">
                    <div className="flex justify-between">
                      <div className="h-4 w-32 bg-gray-200 rounded"></div>
                      <div className="h-4 w-24 bg-gray-200 rounded"></div>
                    </div>
                    <div className="flex justify-between">
                      <div className="h-4 w-28 bg-gray-200 rounded"></div>
                      <div className="h-4 w-20 bg-gray-200 rounded"></div>
                    </div>
                    <div className="flex justify-between">
                      <div className="h-4 w-36 bg-gray-200 rounded"></div>
                      <div className="h-4 w-16 bg-gray-200 rounded"></div>
                    </div>
                  </div>

                  {/* Total */}
                  <div className="pt-4">
                    <div className="flex justify-between mb-4">
                      <div className="h-5 w-16 bg-gray-300 rounded"></div>
                      <div className="h-5 w-28 bg-gray-300 rounded"></div>
                    </div>
                  </div>

                  {/* Mensaje T&C */}
                  <div className="space-y-2">
                    <div className="h-3 w-full bg-gray-200 rounded"></div>
                    <div className="h-3 w-3/4 bg-gray-200 rounded"></div>
                  </div>

                  {/* Botones */}
                  <div className="h-12 w-full bg-gray-300 rounded-lg"></div>

                  {/* Términos centrados */}
                  <div className="mt-3 space-y-2">
                    <div className="h-3 w-full bg-gray-200 rounded"></div>
                    <div className="h-3 w-5/6 bg-gray-200 rounded mx-auto"></div>
                    <div className="h-3 w-4/6 bg-gray-200 rounded mx-auto"></div>
                  </div>

                  {/* Información de financiamiento y envío */}
                  <div className="mt-6 space-y-4">
                    {/* Financiamiento */}
                    <div className="flex gap-3">
                      <div className="w-10 h-10 bg-gray-200 rounded shrink-0"></div>
                      <div className="flex-1 space-y-2">
                        <div className="h-3 w-full bg-gray-200 rounded"></div>
                        <div className="h-3 w-5/6 bg-gray-200 rounded"></div>
                        <div className="h-3 w-4/6 bg-gray-200 rounded"></div>
                      </div>
                    </div>

                    {/* Envío */}
                    <div className="flex gap-3">
                      <div className="w-10 h-10 bg-gray-200 rounded shrink-0"></div>
                      <div className="flex-1 space-y-2">
                        <div className="h-3 w-full bg-gray-200 rounded"></div>
                        <div className="h-3 w-5/6 bg-gray-200 rounded"></div>
                        <div className="h-3 w-3/6 bg-gray-200 rounded"></div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            ) : paymentData?.method === "datafono_efectivo" && isKioskMode ? (
              /* Datafono/Efectivo: flujo de 2 botones */
              <Step4OrderSummary
                isProcessing={isProcessing || isConfirmingDatafono}
                onFinishPayment={datafonoOrderCreated ? handleDatafonoConfirm : handleConfirmOrder}
                onBack={datafonoOrderCreated ? handleKioskFinalize : onBack}
                backText={datafonoOrderCreated ? "Cancelar" : "Volver"}
                buttonText={
                  datafonoOrderCreated
                    ? (isConfirmingDatafono ? "Confirmando..." : "Confirmar compra")
                    : (isProcessing ? "Posteando orden..." : "Postear orden")
                }
                buttonVariant="green"
                disabled={isProcessing || isConfirmingDatafono || isValidatingTradeIn || !tradeInValidation.isValid}
                isSticky={true}
                shippingVerification={shippingVerification}
                deliveryMethod={shippingData?.type}
                error={error}
                shouldCalculateCanPickUp={false}
                debugStoresInfo={{
                  availableStoresWhenCanPickUpFalse: availableStoresWhenCanPickUpFalse.length,
                  stores: stores.length,
                  filteredStores: filteredStores.length,
                  availableCities: availableCities.length,
                }}
              />
            ) : (
              <>
                {kioskPaymentLinkSent?.serialId && (
                  <div className="bg-green-50 border-2 border-green-300 rounded-lg p-3 mb-3 text-center">
                    <p className="text-xs text-green-700 font-medium">N° de orden</p>
                    <p className="text-xl font-bold text-green-900 tracking-wide">
                      {kioskPaymentLinkSent.serialId}
                    </p>
                  </div>
                )}
                <Step4OrderSummary
                  isProcessing={isProcessing || isResending}
                  onFinishPayment={kioskPaymentLinkSent ? handleKioskResendLink : handleConfirmOrder}
                  onBack={kioskPaymentLinkSent ? handleKioskFinalize : onBack}
                  backText={kioskPaymentLinkSent ? "Finalizar orden" : "Volver"}
                  buttonText={kioskPaymentLinkSent ? (isResending ? "Reenviando..." : (resendCooldown > 0 ? `Reenviar link (${resendCooldown}s)` : "Reenviar link")) : (isKioskMode && paymentData?.method === "tarjeta" ? "Confirmar orden y proceder al pago" : (isKioskMode ? "Enviar link de pago" : "Confirmar y pagar"))}
                  buttonVariant="green"
                  disabled={kioskPaymentLinkSent ? (isResending || resendCooldown > 0) : (isProcessing || isResending || isValidatingTradeIn || !tradeInValidation.isValid)}
                  isSticky={true}
                  shippingVerification={shippingVerification}
                  deliveryMethod={shippingData?.type}
                  error={error}
                  shouldCalculateCanPickUp={false}
                  debugStoresInfo={{
                    availableStoresWhenCanPickUpFalse: availableStoresWhenCanPickUpFalse.length,
                    stores: stores.length,
                    filteredStores: filteredStores.length,
                    availableCities: availableCities.length,
                  }}
                />
              </>
            )}
            {/* Información del método de envío - Solo se muestra cuando NEXT_PUBLIC_SHOW_PRODUCT_CODES es true */}
            {process.env.NEXT_PUBLIC_SHOW_PRODUCT_CODES === "true" && (
              <div className="bg-blue-50 border-2 border-blue-200 rounded-lg p-4">
                {isLoadingCanPickUp ? (
                  /* Skeleton mientras carga - incluye título */
                  <div className="animate-pulse space-y-3">
                    <div className="h-4 w-40 bg-blue-200 rounded mb-3"></div>
                    <div className="flex items-start gap-4">
                      <div className="h-4 w-16 bg-blue-200 rounded"></div>
                      <div className="h-4 w-32 bg-blue-200 rounded"></div>
                    </div>
                    <div className="p-4 bg-white/50 rounded border border-blue-200">
                      <div className="h-3 w-40 bg-blue-200 rounded mb-2"></div>
                      <div className="space-y-1.5">
                        <div className="h-3 w-full bg-blue-200 rounded"></div>
                        <div className="h-3 w-full bg-blue-200 rounded"></div>
                        <div className="h-3 w-full bg-blue-200 rounded"></div>
                      </div>
                    </div>
                  </div>
                ) : (
                  <>
                    <p className="text-sm font-bold text-blue-900 mb-3">
                      📦 Método de envío
                    </p>
                    <div className="space-y-2 text-sm text-blue-800">
                      {shippingData?.type === "pickup" ? (
                        <>
                          <div className="flex items-start gap-4">
                            <span className="font-semibold">Método:</span>
                            <span className="text-green-700 font-bold">
                              🏪 Recoge en tienda
                            </span>
                          </div>
                          {shippingData.store?.name && (
                            <div className="flex items-start gap-4">
                              <span className="font-semibold">Tienda:</span>
                              <span>{shippingData.store.name}</span>
                            </div>
                          )}
                        </>
                      ) : (
                        <>
                          <div className="flex items-start gap-4">
                            <span className="font-semibold">Método:</span>
                            {shippingVerification?.envio_imagiq === true ? (
                              <span className="text-green-700 font-bold">
                                🚚 Envío Imagiq
                              </span>
                            ) : (
                              <span className="text-orange-700 font-bold">
                                🚛 Envío Coordinadora
                              </span>
                            )}
                          </div>
                          <div className="mt-2 p-4 bg-white/50 rounded border border-blue-200">
                            <p className="text-xs font-semibold mb-1">
                              Detalles de verificación:
                            </p>
                            <div className="text-xs space-y-1">
                              <p>
                                • envio_imagiq:{" "}
                                {shippingVerification?.envio_imagiq ? (
                                  <span className="text-green-600 font-bold">
                                    true
                                  </span>
                                ) : (
                                  <span className="text-red-600 font-bold">
                                    false
                                  </span>
                                )}
                              </p>
                              <p>
                                • todos_productos_im_it_av:{" "}
                                {shippingVerification?.todos_productos_im_it ? (
                                  <span className="text-green-600 font-bold">
                                    true
                                  </span>
                                ) : (
                                  <span className="text-red-600 font-bold">
                                    false
                                  </span>
                                )}
                              </p>
                              <p>
                                • todos_productos_solo_im:{" "}
                                {shippingVerification?.todos_productos_solo_im ? (
                                  <span className="text-green-600 font-bold">
                                    true
                                  </span>
                                ) : (
                                  <span className="text-gray-600 font-bold">
                                    false
                                  </span>
                                )}
                              </p>
                              <p>
                                • productos_no_im_tienen_remota:{" "}
                                {shippingVerification?.todos_productos_solo_im ? (
                                  <span className="text-gray-500 italic">
                                    n/a (todos IM)
                                  </span>
                                ) : shippingVerification?.productos_no_im_tienen_remota ? (
                                  <span className="text-green-600 font-bold">
                                    true
                                  </span>
                                ) : (
                                  <span className="text-red-600 font-bold">
                                    false
                                  </span>
                                )}
                              </p>
                              <p>
                                • en_zona_cobertura:{" "}
                                {shippingVerification?.en_zona_cobertura ? (
                                  <span className="text-green-600 font-bold">
                                    true
                                  </span>
                                ) : (
                                  <span className="text-red-600 font-bold">
                                    false
                                  </span>
                                )}
                              </p>
                              <p>
                                • es_centro_distribucion:{" "}
                                {isLoadingStoreValidation ? (
                                  <span className="text-yellow-600 italic">
                                    verificando...
                                  </span>
                                ) : isCentroDistribucion === null ? (
                                  <span className="text-gray-600 italic">
                                    no verificado
                                  </span>
                                ) : isCentroDistribucion ? (
                                  <span className="text-green-600 font-bold">
                                    true
                                  </span>
                                ) : (
                                  <span className="text-red-600 font-bold">
                                    false
                                  </span>
                                )}
                              </p>
                            </div>
                          </div>
                        </>
                      )}
                    </div>
                  </>
                )}
              </div>
            )}

            {/* Banner de Trade-In - Mostrar para cada producto con trade-in */}
            {Object.entries(tradeInDataMap).map(([sku, tradeIn]) => {
              if (!tradeIn?.completed) return null;
              return (
                <TradeInCompletedSummary
                  key={sku}
                  deviceName={tradeIn.deviceName}
                  tradeInValue={tradeIn.value}
                  onEdit={() => handleRemoveTradeIn(sku)}
                  validationError={
                    tradeInValidation.isValid === false
                      ? getTradeInValidationMessage(tradeInValidation)
                      : undefined
                  }
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
              $ {Number(calculations.total).toLocaleString()}
            </p>
            {/* Mostrar descuento si existe */}
            {productSavings > 0 && (
              <p className="text-sm text-green-600 font-medium">
                -$ {Number(productSavings).toLocaleString()} desc.
              </p>
            )}
            {kioskPaymentLinkSent?.serialId && (
              <p className="text-sm text-green-700 font-semibold mt-1">
                N° de orden: <span className="font-bold">{kioskPaymentLinkSent.serialId}</span>
              </p>
            )}
          </div>

          {/* Derecha: Botón confirmar - destacado con sombra y glow */}
          <div className="flex flex-col items-end gap-1">
            <button
              className={`flex-shrink-0 font-bold py-4 px-6 rounded-xl text-lg transition-all duration-200 text-white border-2 flex items-center gap-2 ${
                isProcessing || isValidatingTradeIn || !tradeInValidation.isValid || (kioskPaymentLinkSent && resendCooldown > 0)
                  ? "bg-gray-400 border-gray-300 cursor-not-allowed"
                  : "bg-green-600 border-green-500 hover:bg-green-700 hover:border-green-600 cursor-pointer shadow-lg shadow-green-500/40 hover:shadow-xl hover:shadow-green-500/50"
              }`}
              onClick={kioskPaymentLinkSent ? handleKioskResendLink : handleConfirmOrder}
              disabled={isProcessing || isResending || isValidatingTradeIn || !tradeInValidation.isValid || !!(kioskPaymentLinkSent && resendCooldown > 0)}
            >
              {(isProcessing || isResending || isCalculatingShipping || isValidatingTradeIn) && (
                <svg className="animate-spin h-5 w-5 text-white" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                </svg>
              )}
              <span>{isProcessing || isResending || isValidatingTradeIn ? "Procesando..." : (kioskPaymentLinkSent ? "Reenviar link" : (isKioskMode ? "Enviar link de pago" : "Confirmar y pagar"))}</span>
            </button>
            {kioskPaymentLinkSent && resendCooldown > 0 && (
              <span className="text-xs text-gray-500">Reenviar en {resendCooldown}s</span>
            )}
          </div>
        </div>
      </div>

      {/* Modal para registrar contraseña de usuario invitado */}
      <RegisterGuestPasswordModal
        isOpen={showPasswordModal}
        onClose={handleModalClose}
        onSuccess={handleRegisterSuccess}
        userEmail={
          loggedUser?.email ||
          billingData?.email ||
          recipientData?.email ||
          (() => {
            try {
              const userInfo = localStorage.getItem("imagiq_user");
              if (userInfo) {
                const parsed = JSON.parse(userInfo);
                return parsed?.email || "";
              }
            } catch {
              return "";
            }
            return "";
          })()
        }
        userName={
          loggedUser?.nombre ||
          (billingData?.nombre ? billingData.nombre.split(" ")[0] : "") ||
          recipientData?.firstName ||
          ""
        }
        userLastName={
          loggedUser?.apellido ||
          (billingData?.nombre ? billingData.nombre.split(" ").slice(1).join(" ") : "") ||
          recipientData?.lastName ||
          ""
        }
      />
    </div>
    </>
  );
}
