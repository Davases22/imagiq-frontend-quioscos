"use client";
import { useState, useCallback, useEffect } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { usePurchaseFlow } from "@/hooks/usePurchaseFlow";
import { useCart } from "@/hooks/useCart";
import { CardData, CardErrors } from "../components/CreditCardForm";
import {
  PaymentMethod,
  BeneficiosDTO,
  CheckZeroInterestResponse,
} from "../types";
import {
  payWithAddi,
  payWithCard,
  payWithSavedCard,
  payWithPse,
} from "../utils";
import { validateCardFields } from "../utils/cardValidation";
import { safeGetLocalStorage, safeSetLocalStorage } from "@/lib/localStorage";
import { useCardsCache } from "./useCardsCache";
import useSecureStorage from "@/hooks/useSecureStorage";

/**
 * Extrae los beneficios de trade-in desde localStorage
 * Maneja tanto el formato antiguo como el nuevo formato indexado por SKU
 * IMPORTANTE: Solo incluye trade-ins cuyo SKU coincida con un producto en el carrito
 * @param cartProducts - Array de productos del carrito con sus identificadores
 * @returns Array de beneficios de tipo entrego_y_estreno
 */
function extractTradeInBeneficios(cartProducts: { sku: string; id?: string; skuPostback?: string }[]): BeneficiosDTO[] {
  const beneficios: BeneficiosDTO[] = [];
  // Crear un Set con todos los identificadores posibles del carrito (sku, id, skuPostback)
  const cartIdentifiers = new Set<string>();
  for (const p of cartProducts) {
    if (p.sku) cartIdentifiers.add(p.sku);
    if (p.id) cartIdentifiers.add(p.id);
    if (p.skuPostback) cartIdentifiers.add(p.skuPostback);
  }
  console.log('[extractTradeInBeneficios] Cart identifiers:', Array.from(cartIdentifiers));
  try {
    const tradeStr = localStorage.getItem("imagiq_trade_in");
    console.log('[extractTradeInBeneficios] Raw localStorage:', tradeStr);
    if (!tradeStr) return beneficios;

    const parsedTrade = JSON.parse(tradeStr);

    // Formato antiguo: { deviceName, value, completed, detalles, sku }
    // IMPORTANTE: Validar que el SKU del trade-in coincida con un producto del carrito
    if (parsedTrade?.completed && parsedTrade?.deviceName) {
      const tradeInSku = parsedTrade.sku;
      console.log('[extractTradeInBeneficios] Formato antiguo - SKU:', tradeInSku, 'Coincide con carrito:', cartIdentifiers.has(tradeInSku));
      // Solo agregar si el SKU del trade-in está en el carrito
      if (tradeInSku && cartIdentifiers.has(tradeInSku)) {
        const beneficio = {
          type: "entrego_y_estreno" as const,
          dispositivo_a_recibir: parsedTrade.deviceName,
          valor_retoma: parsedTrade.value,
          detalles_dispositivo_a_recibir: parsedTrade.detalles,
          sku: tradeInSku, // Backend espera 'sku', no 'sku_producto'
        };
        console.log('[extractTradeInBeneficios] Agregando beneficio Trade-In:', beneficio);
        beneficios.push(beneficio);
      }
      return beneficios;
    }

    // Formato nuevo: { "SKU": { sku, name, skuPostback, deviceName, value, completed, detalles } }
    // IMPORTANTE: Solo incluir trade-ins cuyo SKU (key del objeto) coincida con un producto del carrito
    if (typeof parsedTrade === 'object' && !parsedTrade.deviceName) {
      console.log('[extractTradeInBeneficios] Formato nuevo - Keys:', Object.keys(parsedTrade));
      for (const tradeKey of Object.keys(parsedTrade)) {
        const tradeInData = parsedTrade[tradeKey];
        // El tradeKey es el SKU original del producto (ej: SM-S938BZKJLTC)
        // Verificar si el tradeKey o el sku interno coincide con algún identificador del carrito
        const matchesCart = cartIdentifiers.has(tradeKey) || (tradeInData?.sku && cartIdentifiers.has(tradeInData.sku));
        console.log('[extractTradeInBeneficios] Procesando tradeKey:', tradeKey, 'sku interno:', tradeInData?.sku, 'completed:', tradeInData?.completed, 'Coincide con carrito:', matchesCart);

        // Solo agregar si el Trade-In key o sku está en el carrito
        if (tradeInData?.completed && tradeInData?.deviceName && matchesCart) {
          const beneficio = {
            type: "entrego_y_estreno" as const,
            dispositivo_a_recibir: tradeInData.deviceName,
            valor_retoma: tradeInData.value,
            detalles_dispositivo_a_recibir: tradeInData.detalles,
            sku: tradeKey, // Backend espera 'sku', no 'sku_producto'
          };
          console.log('[extractTradeInBeneficios] Agregando beneficio Trade-In:', beneficio);
          beneficios.push(beneficio);
        }
      }
    }
  } catch (e) {
    console.error('[extractTradeInBeneficios] Error:', e);
  }
  console.log('[extractTradeInBeneficios] Beneficios finales:', beneficios);
  return beneficios;
}

/**
 * Extrae los beneficios de bundle desde los productos del carrito
 * @param cartProducts - Array de productos del carrito
 * @returns Array de beneficios de tipo bundle
 */
function extractBundleBeneficios(cartProducts: { sku: string; name?: string; skuPostback?: string; bundleInfo?: { codCampana: string; productSku: string; bundleDiscount?: number } }[]): BeneficiosDTO[] {
  const beneficios: BeneficiosDTO[] = [];
  console.log('[extractBundleBeneficios] Productos del carrito:', cartProducts.map(p => ({ sku: p.sku, hasBundleInfo: !!p.bundleInfo, bundleInfo: p.bundleInfo })));

  // Agrupar productos por bundle (productSku del bundleInfo)
  const bundleGroups = new Map<string, typeof cartProducts>();

  for (const product of cartProducts) {
    if (product.bundleInfo?.productSku) {
      const bundleKey = product.bundleInfo.productSku;
      console.log('[extractBundleBeneficios] Producto con bundle:', product.sku, '-> bundleKey:', bundleKey);
      if (!bundleGroups.has(bundleKey)) {
        bundleGroups.set(bundleKey, []);
      }
      bundleGroups.get(bundleKey)!.push(product);
    }
  }

  console.log('[extractBundleBeneficios] Bundle groups:', Array.from(bundleGroups.keys()));

  // Crear un beneficio por cada bundle único
  for (const [productSku, products] of bundleGroups) {
    const firstProduct = products[0];
    if (firstProduct.bundleInfo) {
      const beneficio = {
        type: "bundle" as const,
        sku: productSku, // Backend espera 'sku', no 'sku_producto'
        descuento_bundle: firstProduct.bundleInfo.bundleDiscount,
      };
      console.log('[extractBundleBeneficios] Agregando beneficio Bundle:', beneficio);
      beneficios.push(beneficio);
    }
  }

  console.log('[extractBundleBeneficios] Beneficios finales:', beneficios);
  return beneficios;
}

/**
 * Construye el array de beneficios para enviar al backend
 * SIEMPRE incluye 0%_interes con aplica: true o false
 * @param cartProducts - Productos del carrito
 * @param paymentMethod - Método de pago ('tarjeta' | 'addi' | 'pse')
 * @param zeroInterestApplies - Si aplica 0% interés (solo para tarjeta)
 */
function buildBeneficiosArray(
  cartProducts: { sku: string; id?: string; skuPostback?: string; name?: string; bundleInfo?: { codCampana: string; productSku: string; bundleDiscount?: number } }[],
  paymentMethod: 'tarjeta' | 'addi' | 'pse',
  zeroInterestApplies: boolean = false
): BeneficiosDTO[] {
  console.log(`[buildBeneficiosArray - ${paymentMethod.toUpperCase()}] Iniciando construcción de beneficios`);

  const beneficios: BeneficiosDTO[] = [
    ...extractTradeInBeneficios(cartProducts),
    ...extractBundleBeneficios(cartProducts),
  ];

  // SIEMPRE incluir el beneficio de 0% interés con aplica: true o false
  // Para tarjeta: depende de la tarjeta y cuotas seleccionadas
  // Para ADDI y PSE: siempre aplica: false
  const aplica0Interes = paymentMethod === 'tarjeta' ? zeroInterestApplies : false;
  beneficios.push({ type: "0%_interes", aplica: aplica0Interes });
  console.log(`[buildBeneficiosArray - ${paymentMethod.toUpperCase()}] 0% interés aplica: ${aplica0Interes}`);

  console.log(`[buildBeneficiosArray - ${paymentMethod.toUpperCase()}] BENEFICIOS FINALES:`, JSON.stringify(beneficios, null, 2));
  return beneficios;
}

export function useCheckoutLogic() {
  const { redirectToError } = usePurchaseFlow();
  const router = useRouter();
  const { products: cartProducts, appliedDiscount, calculations } = useCart();
  const [checkoutAddress, _] = useSecureStorage<{ id: string } | null>("checkout-address", null);

  // Hook de caché para zero interest
  const {
    zeroInterestData: cachedZeroInterestData,
    isLoadingZeroInterest: cachedIsLoadingZeroInterest,
    loadZeroInterest,
  } = useCardsCache();

  // Estados principales
  const [error, setError] = useState("");
  const [isProcessing, setIsProcessing] = useState(false);
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>("tarjeta");
  const [selectedBank, setSelectedBank] = useState<string>("");
  const [selectedBankName, setSelectedBankName] = useState<string>("");

  // Estados para tarjetas guardadas
  const [selectedCardId, setSelectedCardId] = useState<string | null>(() => {
    if (typeof window !== "undefined") {
      return localStorage.getItem("checkout-saved-card-id");
    }
    return null;
  });

  const [useNewCard, setUseNewCard] = useState(() => {
    if (typeof window !== "undefined") {
      const savedCardId = localStorage.getItem("checkout-saved-card-id");
      const tempCardData = localStorage.getItem("checkout-card-data");
      // If we have temporary card data and NO saved card selected, default to new card
      if (tempCardData && !savedCardId) {
        return true;
      }
    }
    return false;
  });
  const [isAddCardModalOpen, setIsAddCardModalOpen] = useState(false);
  // Contador para forzar recarga de tarjetas guardadas
  const [savedCardsReloadCounter, setSavedCardsReloadCounter] = useState(0);

  // Usar datos del caché para zero interest
  const zeroInterestData = cachedZeroInterestData;
  const isLoadingZeroInterest = cachedIsLoadingZeroInterest;

  const [card, setCard] = useState<CardData>(() => {
    let cedula = "";
    let initialCardData = {
      number: "",
      expiryMonth: "",
      expiryYear: "",
      cvc: "",
      name: "",
      docType: "C.C.",
      docNumber: "",
      installments: "1",
    };

    if (typeof window !== "undefined") {
      const savedDoc = localStorage.getItem("checkout-document");
      if (savedDoc) {
        cedula = savedDoc;
        initialCardData.docNumber = savedDoc;
      }

      // Check for temporary card data
      try {
        const tempCardData = localStorage.getItem("checkout-card-data");
        if (tempCardData) {
          const parsed = JSON.parse(tempCardData);
          initialCardData = {
            ...initialCardData,
            number: parsed.cardNumber || "",
            name: parsed.cardHolder || "",
            expiryMonth: parsed.cardExpMonth || "",
            expiryYear: parsed.cardExpYear || "",
            cvc: parsed.cardCvc || "",
            // Preserve docNumber if not in temp data
            docNumber: parsed.docNumber || cedula,
            installments: parsed.installments || "1"
          };
        }
      } catch (e) {
        console.error("Error parsing temporary card data:", e);
      }
    }
    return initialCardData;
  });
  const [cardErrors, setCardErrors] = useState<CardErrors>({
    number: "",
    expiryMonth: "",
    expiryYear: "",
    cvc: "",
    name: "",
    docNumber: "",
  });
  const [billingError, setBillingError] = useState("");
  const [billingType, setBillingType] = useState("");
  const [accepted, setAccepted] = useState(false);
  const [saveInfo, setSaveInfo] = useState(false);

  // Computed values
  const isAmex = card.number.startsWith("34") || card.number.startsWith("37");

  // Handlers
  const handleCardChange = (newCard: CardData) => {
    setCard(newCard);
  };

  const handleCardErrorChange = (errors: Partial<CardErrors>) => {
    setCardErrors((prev) => ({ ...prev, ...errors }));
  };

  const handlePaymentMethodChange = (method: PaymentMethod) => {
    setPaymentMethod(method);
    if (method !== "pse") {
      setSelectedBank("");
      setSelectedBankName("");
    }
  };

  const handleBankChange = (bankCode: string, bankName?: string) => {
    setSelectedBank(bankCode);
    if (bankName) setSelectedBankName(bankName);
  };

  const handleBillingTypeChange = (type: string) => {
    setBillingType(type);
    setBillingError("");
  };

  // Handlers para tarjetas guardadas
  const handleCardSelect = (cardId: string | null) => {
    setSelectedCardId(cardId);
  };

  const handleOpenAddCardModal = () => {
    setIsAddCardModalOpen(true);
  };

  const handleCloseAddCardModal = () => {
    setIsAddCardModalOpen(false);
    // Forzar recarga de tarjetas guardadas al cerrar el modal
    setSavedCardsReloadCounter((c) => c + 1);
  };

  // Cerrar modal después de agregar tarjeta y solicitar recarga de tarjetas
  const handleAddCardSuccess = async (newCardId?: string) => {
    setIsAddCardModalOpen(false);

    // Forzar recarga de tarjetas - la tarjeta se seleccionará automáticamente en PaymentForm después de recargar
    setSavedCardsReloadCounter((c) => c + 1);
    setPaymentMethod("tarjeta");
    setUseNewCard(false);

    // Si se proporcionó el ID de la nueva tarjeta, consultar cuotas sin interés
    if (newCardId) {
      fetchZeroInterestInfo([newCardId]);
    }
  };

  const handleUseNewCardChange = (useNew: boolean) => {
    setUseNewCard(useNew);
    // If user chooses to use a new card, clear selected saved card.
    if (useNew) {
      setSelectedCardId(null);
    }
  };

  // Función para consultar información de cuotas sin interés (ahora usa el caché)
  const fetchZeroInterestInfo = useCallback(
    async (cardIds: string[]) => {
      if (cardIds.length === 0) return;

      await loadZeroInterest(
        cardIds,
        cartProducts.map((p) => p.sku),
        calculations.total
      );
    },
    [cartProducts, calculations.total, loadZeroInterest]
  );

  // Effects para sincronizar carrito y descuento - Ya no necesarios con useCart

  // Cargar método de pago guardado de localStorage al montar
  useEffect(() => {
    const savedPaymentMethod = localStorage.getItem("checkout-payment-method");
    if (savedPaymentMethod) {
      setPaymentMethod(savedPaymentMethod as PaymentMethod);
    }

    const savedBankData = localStorage.getItem("checkout-selected-bank");
    if (savedBankData) {
      try {
        const { code, name } = JSON.parse(savedBankData);
        setSelectedBank(code);
        setSelectedBankName(name);
      } catch (error) {
        console.error("Error parsing saved bank data:", error);
      }
    }
  }, []);

  // Función para validar y guardar datos de pago (sin procesar aún)
  const handleSavePaymentData = async (e: React.FormEvent) => {
    e.preventDefault();
    let valid = true;
    setError("");

    // Detectar si estamos en modo kiosco
    const isKioskMode = typeof window !== 'undefined' && !!localStorage.getItem("kiosk_client_id");

    // Validar método de pago
    if (!paymentMethod) {
      setError("Selecciona un método de pago");
      valid = false;
    }

    // Validar campos de tarjeta si corresponde
    // Kiosk (rol 5): no requiere datos de tarjeta (es pago presencial datafono/efectivo)
    if (paymentMethod === "tarjeta" && !isKioskMode) {
      // Verificar que haya seleccionado una tarjeta guardada O esté usando una nueva
      const hasTempCard = typeof window !== 'undefined' && localStorage.getItem("checkout-card-data");

      if (!selectedCardId && !hasTempCard) {
        setError("Debes seleccionar una tarjeta o ingresar los datos de una nueva.");
        valid = false;
      }
    }

    // Validar banco si se seleccionó PSE (kiosk mode skips bank - customer selects later)
    if (paymentMethod === "pse" && !selectedBank && !isKioskMode) {
      setError("Debes seleccionar un banco para pagar con PSE");
      valid = false;
    }

    // Si hay errores, no continuar
    if (!valid) {
      return false;
    }

    // Guardar datos en localStorage para usarlos después
    localStorage.setItem("checkout-payment-method", paymentMethod);

    if (paymentMethod === "tarjeta") {
      // Solo guardar tarjetas guardadas (ya no se permiten nuevas tarjetas en step 4)
      if (selectedCardId) {
        localStorage.setItem("checkout-saved-card-id", selectedCardId);
        localStorage.setItem(
          "checkout-card-installments",
          card.installments || "1"
        );

        // Guardar información de cuotas sin interés para usar en Step5
        if (zeroInterestData) {
          safeSetLocalStorage("checkout-zero-interest", zeroInterestData);
        }
      } else {
        // Si no hay tarjeta guardada seleccionada (es tarjeta nueva), limpiar el ID guardado
        localStorage.removeItem("checkout-saved-card-id");
      }
    } else if (paymentMethod === "pse") {
      // Guardar tanto código como nombre del banco para uso en resumen
      const payload = { code: selectedBank, name: selectedBankName || "" };
      localStorage.setItem("checkout-selected-bank", JSON.stringify(payload));
    }

    return true;
  };

  // Función principal de finalización de compra
  const handleFinish = async (e: React.FormEvent) => {
    e.preventDefault();
    let valid = true;
    setBillingError("");
    setError("");

    // Detectar si estamos en modo kiosco
    const isKioskMode = typeof window !== 'undefined' && !!localStorage.getItem("kiosk_client_id");

    // Validar método de pago
    if (!paymentMethod) {
      setError("Selecciona un método de pago");
      valid = false;
    }

    // Validar campos de tarjeta si corresponde
    // Kiosk (rol 5): no requiere datos de tarjeta (es pago presencial datafono/efectivo)
    if (paymentMethod === "tarjeta" && !isKioskMode) {
      // Verificar que haya seleccionado una tarjeta guardada O esté usando una nueva
      const hasTempCard = typeof window !== 'undefined' && localStorage.getItem("checkout-card-data");

      if (!selectedCardId && !hasTempCard) {
        setError("Debes seleccionar una tarjeta o ingresar los datos de una nueva.");
        valid = false;
      }
    }

    // Validar banco si se seleccionó PSE (kiosk mode skips bank - customer selects later)
    if (paymentMethod === "pse" && !selectedBank && !isKioskMode) {
      setError("Debes seleccionar un banco para pagar con PSE");
      valid = false;
    }

    // Validar facturación
    if (!billingType) {
      setBillingError("Selecciona un tipo de facturación");
      valid = false;
    }

    // Validar políticas (obligatorio)
    if (!accepted) {
      setError(
        "Debes aceptar y leer las políticas de privacidad para continuar"
      );
      valid = false;
    }

    // Si hay errores, no continuar
    if (!valid) {
      return;
    }

    // Activar estado de procesamiento
    setIsProcessing(true);

    // Usar cálculos del hook useCart
    const { total, shipping: envio } = calculations;

    // Procesar pago
    try {
      const userInfo = safeGetLocalStorage<{ id?: string }>("imagiq_user", {});
      const direction = safeGetLocalStorage<{ id?: string }>(
        "checkout-address",
        {}
      );
      const billing = safeGetLocalStorage<{
        direccion?: { id?: string };
        email?: string;
        nombre?: string;
        documento?: string;
        tipoDocumento?: string;
        telefono?: string;
        type?: string;
        nit?: string;
        razonSocial?: string;
        nombreRepresentante?: string;
      }>("checkout-billing-data", {});

      const esFacturaEmpresa = billing?.type === "juridica";

      const informacion_facturacion = {
        direccion_id: billing?.direccion?.id ?? direction?.id ?? "",
        email: billing?.email ?? "",
        nombre_completo: billing?.nombre ?? "",
        numero_documento: billing?.documento ?? "",
        tipo_documento: billing?.tipoDocumento ?? "",
        telefono: billing?.telefono ?? "",
        type: billing?.type ?? "",
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
        nit: esFacturaEmpresa ? billing?.nit : "",
        razon_social: esFacturaEmpresa ? billing?.razonSocial : "",
        representante_legal: esFacturaEmpresa
          ? billing?.nombreRepresentante || billing?.nombre
          : "",
      };
      let res;

      switch (paymentMethod) {
        case "addi": {
          // Construir beneficios
          const buildBeneficios = (): BeneficiosDTO[] => {
            console.log('[buildBeneficios - ADDI] Iniciando construcción de beneficios');
            const beneficios: BeneficiosDTO[] = [
              ...extractTradeInBeneficios(cartProducts),
              ...extractBundleBeneficios(cartProducts),
            ];
            // Siempre incluir el beneficio de 0% interés con aplica: true o false
            try {
              const zeroStr = localStorage.getItem("checkout-zero-interest");
              console.log('[buildBeneficios - ADDI] Zero interest data:', zeroStr);
              if (zeroStr) {
                const parsedZero = JSON.parse(zeroStr);
                const aplicaZero =
                  parsedZero?.aplica_zero_interes || parsedZero?.aplica || false;
                console.log('[buildBeneficios - ADDI] Zero interest aplica:', aplicaZero);
                beneficios.push({ type: "0%_interes", aplica: aplicaZero });
              } else {
                // Si no hay datos de zero interest, incluir con aplica: false
                beneficios.push({ type: "0%_interes", aplica: false });
              }
            } catch {
              // En caso de error, incluir con aplica: false
              beneficios.push({ type: "0%_interes", aplica: false });
            }
            if (beneficios.length === 0) return [{ type: "sin_beneficios" }];
            console.log('[buildBeneficios - ADDI] BENEFICIOS FINALES:', JSON.stringify(beneficios, null, 2));
            return beneficios;
          };

          res = await payWithAddi({
            currency: "COP",
            items: cartProducts.map((p) => ({
              name: String(p.name),
              sku: String(p.sku),
              ean: p.ean && p.ean !== "" ? String(p.ean) : String(p.sku),
              quantity: String(p.quantity),
              unitPrice: String(p.price),
              skupostback: p.skuPostback || p.sku || "",
              desDetallada: p.desDetallada || p.name || "",
              categoria: p.categoria || (p.bundleInfo ? "IM" : ""),
              category: p.categoria || (p.bundleInfo ? "IM" : ""),
              // Incluir bundleInfo si el producto es parte de un bundle
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
            metodo_envio: 1,
            shippingAmount: String(envio),
            totalAmount: String(total),
            userInfo: {
              userId: userInfo.id || "",
              direccionId: checkoutAddress?.id || "",
            },
            informacion_facturacion,
            beneficios: buildBeneficios(),
          });
          if ("error" in res) {
            // Check if it's an out-of-stock error
            if (
              res.message.includes("dejó (dejaron) de estar disponobles") ||
              res.message.includes("no está disponible") ||
              res.message.includes("not available")
            ) {
              toast.error("Producto(s) no disponible(s)", {
                description: res.message,
                duration: 5000,
              });
              setIsProcessing(false);
              return;
            }
            // For other errors, redirect to error page
            redirectToError();
          } else {
            router.push(res.redirectUrl);
          }
          break;
        }

        case "tarjeta": {
          // Solo se permite pago con tarjeta guardada (ya no se permiten nuevas tarjetas en step 4)
          if (selectedCardId) {
            // Pago con tarjeta guardada
            res = await payWithSavedCard({
              cardId: selectedCardId,
              dues: card.installments || "1",
              items: cartProducts.map((p) => ({

                name: String(p.name),
                sku: String(p.sku),
                ean: p.ean && p.ean !== "" ? String(p.ean) : String(p.sku),
                quantity: String(p.quantity),
                unitPrice: String(p.price),
                skupostback: p.skuPostback || p.sku || "",
                desDetallada: p.desDetallada || p.name || "",
                categoria: p.categoria || (p.bundleInfo ? "IM" : ""),
                category: p.categoria || (p.bundleInfo ? "IM" : ""),
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
              metodo_envio: 1,
              shippingAmount: String(envio),
              totalAmount: String(total),
              currency: "COP",
              userInfo: {
                userId: userInfo.id || "",
                direccionId: checkoutAddress?.id || "",
              },
              informacion_facturacion,
              beneficios: buildBeneficiosArray(cartProducts, 'tarjeta', (() => {
                // Calcular si aplica 0% interés para esta tarjeta y cuotas
                try {
                  const zeroStr = localStorage.getItem("checkout-zero-interest");
                  if (zeroStr) {
                    const parsedZero = JSON.parse(zeroStr);
                    const aplicaZero = parsedZero?.aplica_zero_interes || parsedZero?.aplica || false;
                    if (aplicaZero) {
                      const installmentsNum = Number(card.installments || 1);
                      const cardId = selectedCardId || localStorage.getItem("checkout-saved-card-id");
                      const matched = parsedZero?.cards?.find(
                        (c: { id: string; eligibleForZeroInterest: boolean; availableInstallments: number[] }) =>
                          String(c.id) === String(cardId)
                      );
                      return !!(matched?.eligibleForZeroInterest && matched.availableInstallments?.includes(installmentsNum));
                    }
                  }
                } catch (e) {
                  console.error('[TARJETA GUARDADA] Error calculando zero interest:', e);
                }
                return false;
              })()),
            });
          } else {
            // Pago con tarjeta nueva
            res = await payWithCard({
              cardCvc: card.cvc,
              cardExpMonth: card.expiryMonth,
              cardExpYear: card.expiryYear,
              cardNumber: card.number,
              dues: card.installments,
              items: cartProducts.map((p) => ({
                name: String(p.name),
                sku: String(p.sku),
                ean: p.ean && p.ean !== "" ? String(p.ean) : String(p.sku),
                quantity: String(p.quantity),
                unitPrice: String(p.price),
                skupostback: p.skuPostback || p.sku || "",
                desDetallada: p.desDetallada || p.name || "",
                categoria: p.categoria || (p.bundleInfo ? "IM" : ""),
                category: p.categoria || (p.bundleInfo ? "IM" : ""),
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
              metodo_envio: 1,
              shippingAmount: String(envio),
              totalAmount: String(total),
              currency: "COP",
              userInfo: {
                userId: userInfo.id || "",
                direccionId: checkoutAddress?.id || "",
              },
              informacion_facturacion,
              beneficios: (() => {
                console.log('[buildBeneficios - TARJETA NUEVA] Iniciando construcción de beneficios');
                const beneficios: BeneficiosDTO[] = [
                  ...extractTradeInBeneficios(cartProducts),
                  ...extractBundleBeneficios(cartProducts),
                ];
                // Para tarjetas nuevas no tenemos card id para verificar, siempre incluir con aplica: false
                beneficios.push({ type: "0%_interes", aplica: false });
                if (beneficios.length === 0)
                  return [{ type: "sin_beneficios" }];
                console.log('[buildBeneficios - TARJETA NUEVA] BENEFICIOS FINALES:', JSON.stringify(beneficios, null, 2));
                return beneficios;
              })(),
            });
          }

          if ("error" in res) {
            // Check if it's an out-of-stock error
            if (
              res.message.includes("dejó (dejaron) de estar disponobles") ||
              res.message.includes("no está disponible") ||
              res.message.includes("not available")
            ) {
              toast.error("Producto(s) no disponible(s)", {
                description: res.message,
                duration: 5000,
              });
              setIsProcessing(false);
              return;
            }
            // For other errors, redirect to error page
            redirectToError();
            break;
          }
          router.push(res.redirectionUrl);
          break;
        }

        case "pse": {
          res = await payWithPse({
            bank: selectedBank,
            bankName: selectedBankName,
            description: "Imagiq Store",
            currency: "COP",
            items: cartProducts.map((p) => ({
              name: String(p.name),
              sku: String(p.sku),
              ean: p.ean && p.ean !== "" ? String(p.ean) : String(p.sku),
              quantity: String(p.quantity),
              unitPrice: String(p.price),
              skupostback: p.skuPostback || p.sku || "",
              desDetallada: p.desDetallada || p.name || "",
              categoria: p.categoria || (p.bundleInfo ? "IM" : ""),
              category: p.categoria || (p.bundleInfo ? "IM" : ""),
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
            metodo_envio: 1,
            shippingAmount: String(envio),
            totalAmount: String(total),
            userInfo: {
              userId: userInfo.id || "",
              direccionId: direction.id || "",
            },
            informacion_facturacion,
            beneficios: (() => {
              console.log('[buildBeneficios - PSE] Iniciando construcción de beneficios');
              const beneficios: BeneficiosDTO[] = [
                ...extractTradeInBeneficios(cartProducts),
                ...extractBundleBeneficios(cartProducts),
              ];
              // PSE no tiene tarjeta, siempre incluir 0% interés con aplica: false
              beneficios.push({ type: "0%_interes", aplica: false });
              if (beneficios.length === 0) return [{ type: "sin_beneficios" }];
              console.log('[buildBeneficios - PSE] BENEFICIOS FINALES:', JSON.stringify(beneficios, null, 2));
              return beneficios;
            })(),
          });
          if ("error" in res) {
            // Check if it's an out-of-stock error
            if (
              res.message.includes("dejó (dejaron) de estar disponobles") ||
              res.message.includes("no está disponible") ||
              res.message.includes("not available")
            ) {
              toast.error("Producto(s) no disponible(s)", {
                description: res.message,
                duration: 5000,
              });
              setIsProcessing(false);
              return;
            }
            // For other errors, redirect to error page
            redirectToError();
            break;
          }
          router.push(res.redirectUrl);
          break;
        }
      }
    } catch (err) {
      console.error("Error al guardar datos de orden:", err);
      redirectToError();
    }
  };

  return {
    // Estados
    error,
    cartProducts,
    appliedDiscount,
    isProcessing,
    paymentMethod,
    selectedBank,
    card,
    cardErrors,
    billingError,
    billingType,
    accepted,
    saveInfo,
    isAmex,

    // Estados de tarjetas guardadas
    selectedCardId,
    useNewCard,
    isAddCardModalOpen,
    savedCardsReloadCounter,

    // Estados de cuotas sin interés
    zeroInterestData,
    isLoadingZeroInterest,

    // Handlers
    handleCardChange,
    handleCardErrorChange,
    handlePaymentMethodChange,
    handleBankChange,
    handleBillingTypeChange,
    handleFinish,
    handleSavePaymentData,

    // Handlers de tarjetas guardadas
    handleCardSelect,
    handleOpenAddCardModal,
    handleCloseAddCardModal,
    handleAddCardSuccess,
    handleUseNewCardChange,

    // Handlers de cuotas sin interés
    fetchZeroInterestInfo,

    // Setters
    setAccepted,
    setSaveInfo,
  };
}
