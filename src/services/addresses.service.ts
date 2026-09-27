/**
 * @module addresses.service
 * @description Servicio para interactuar con el API de direcciones del backend
 */

import { PlaceDetails } from "@/types/places.types";
import type { Address } from "@/types/address";
import { safeGetLocalStorage } from "@/lib/localStorage";
import { apiGet, apiPost, apiPut, apiDelete } from "@/lib/api-client";

/** Mensaje que ve el cliente cuando intenta guardar una dirección sin haber dado su correo. */
export const MENSAJE_SIN_USUARIO =
  "Para guardar una dirección primero ingresa tu correo en el paso anterior.";

export class SinUsuarioError extends Error {
  readonly code = "USUARIO_INVALIDO" as const;
  constructor() {
    super(MENSAJE_SIN_USUARIO);
    this.name = "SinUsuarioError";
  }
}

/**
 * Interface para crear una nueva dirección
 */
export interface CreateAddressRequest {
  nombreDireccion: string;
  tipoDireccion: "casa" | "apartamento" | "oficina" | "otro";
  tipo: "ENVIO" | "FACTURACION" | "AMBOS";
  esPredeterminada?: boolean;
  placeDetails: PlaceDetails;
  // Campos estructurados de la dirección (siguiendo formato Samsung)
  departamento?: string;
  ciudad?: string; // Ciudad seleccionada por el usuario (código DANE)
  nombreCalle?: string;
  numeroPrincipal?: string;
  numeroSecundario?: string;
  numeroComplementario?: string;
  barrio?: string;
  setsReferencia?: string; // Antes "puntoReferencia"
  instruccionesEntrega?: string;
  // Campos legacy (mantener por compatibilidad)
  complemento?: string;
  puntoReferencia?: string;
  usuarioId?: string; // Para usuarios invitados sin JWT
}

/**
 * Interface para la respuesta de dirección (compatibilidad)
 * @deprecated Use Address type from @/types/address instead
 */
export type AddressResponse = Address;

/**
 * Clase de servicio para direcciones
 */
export class AddressesService {
  private static instance: AddressesService;

  /**
   * Constructor privado para implementar Singleton
   */
  private constructor() {}

  /**
   * Obtiene la instancia única del servicio
   */
  public static getInstance(): AddressesService {
    if (!AddressesService.instance) {
      AddressesService.instance = new AddressesService();
    }
    return AddressesService.instance;
  }

  /**
   * Obtiene el userId correcto para operaciones de dirección en modo kiosk
   * Prioridad: kiosk_client_id > imagiq_user.id > imagiq_user.email > guest ID
   */
  private getKioskUserId(): { userId: string; source: string } | null {
    // 1. Verificar kiosk_client_id (objeto JSON con datos del cliente)
    const kioskClientIdRaw = typeof window !== 'undefined' ? localStorage.getItem("kiosk_client_id") : null;
    let kioskClientId: string | null = null;
    if (kioskClientIdRaw) {
      try {
        const parsed = JSON.parse(kioskClientIdRaw);
        kioskClientId = parsed?.userId ?? null;
      } catch {
        kioskClientId = null;
      }
    }
    // 2. Verificar imagiq_user
    const userInfo = safeGetLocalStorage<{ id?: string; email?: string }>("imagiq_user", {});

    // Log del estado para debugging
    console.log("🔍 [addressesService] Estado de localStorage:", {
      kiosk_client_id: kioskClientId,
      imagiq_user_id: userInfo.id,
    });

    if (kioskClientId) {
      return { userId: kioskClientId, source: "kiosk_client_id" };
    }

    if (userInfo.id) {
      return { userId: userInfo.id, source: "imagiq_user.id" };
    }

    if (userInfo.email) {
      return { userId: userInfo.email, source: "imagiq_user.email" };
    }

    return null;
  }

  /**
   * Crea una nueva dirección
   */
  public async createAddress(
    addressData: CreateAddressRequest
  ): Promise<Address> {
    try {
      const requestData = { ...addressData };

      // SIEMPRE incluir usuarioId explícitamente
      // Usar getKioskUserId para obtener el userId correcto
      const kioskUser = this.getKioskUserId();
      if (kioskUser) {
        requestData.usuarioId = kioskUser.userId;
        console.log(`🏪 addressesService.createAddress: Usando ${kioskUser.source}: ${kioskUser.userId}`);
      } else {
        // Sin usuario identificado no se inventa un "guest_<fecha>_<aleatorio>":
        // ese valor no corresponde a nadie, addresses-ms lo rechaza (usuarios.id
        // es UUID) y el cliente veía un 500. Se pide el correo.
        throw new SinUsuarioError();
      }

      // Verificar si es la primera dirección del usuario
      const existingAddresses = await this.getUserAddresses();
      const isFirstAddress = existingAddresses.length === 0;

      console.log("📤 Enviando datos de dirección:", {
        ...requestData,
        placeDetails: requestData.placeDetails ? "PlaceDetails object" : "null",
        isFirstAddress,
        existingAddressesCount: existingAddresses.length,
      });

      // Log detallado del body que se enviará
      console.log(
        "📦 Body completo que se enviará al backend:",
        JSON.stringify(requestData, null, 2)
      );

      let result: Address;
      try {
        result = await apiPost<Address>("/api/addresses", requestData);
        console.log("✅ Dirección creada exitosamente:", result);
      } catch (apiError) {
        console.error("❌ ERROR al llamar POST /api/addresses:", apiError);
        console.error("❌ Request data que falló:", JSON.stringify(requestData, null, 2));
        throw apiError;
      }

      // Si es la primera dirección O si se marcó como predeterminada,
      // llamar a setDefaultAddress para desactivar las demás
      if (isFirstAddress || addressData.esPredeterminada) {
        try {
          const reason = isFirstAddress
            ? "Es la primera dirección"
            : "Fue marcada como predeterminada";
          console.log(
            `🔄 ${reason}, estableciendo como predeterminada y desactivando las demás...`
          );
          const defaultAddress = await this.setDefaultAddress(result.id);
          console.log(
            "✅ Dirección marcada como predeterminada:",
            defaultAddress.nombreDireccion
          );
          return defaultAddress;
        } catch (setDefaultError) {
          console.error(
            "⚠️ Error estableciendo dirección como predeterminada:",
            setDefaultError
          );
          // No lanzar error, la dirección ya fue creada exitosamente
          // El usuario puede establecerla manualmente como predeterminada si es necesario
        }
      }

      return result;
    } catch (error: unknown) {
      console.error("❌ Error creando dirección:", error);
      const errorMessage =
        error instanceof Error
          ? error.message
          : "Error desconocido creando dirección";
      throw new Error(errorMessage);
    }
  }

  /**
   * Obtiene todas las direcciones del usuario
   */
  public async getUserAddresses(): Promise<Address[]> {
    try {
      const kioskUser = this.getKioskUserId();
      let endpoint = "/api/addresses";

      if (kioskUser) {
        endpoint += `?usuarioId=${encodeURIComponent(kioskUser.userId)}`;
      } else {
        console.warn("No hay información de usuario para obtener direcciones");
        return [];
      }

      const data = await apiGet<Address[]>(endpoint);
      return data;
    } catch (error: unknown) {
      const errorMessage =
        error instanceof Error ? error.message : "Error obteniendo direcciones";
      console.error("Error en getUserAddresses:", errorMessage);
      // Retornar array vacío en lugar de lanzar error
      return [];
    }
  }

  /**
   * Obtiene direcciones por tipo
   */
  public async getUserAddressesByType(
    tipo: "ENVIO" | "FACTURACION" | "AMBOS",
    usuarioId: string
  ): Promise<Address[]> {
    try {
      return await apiGet<Address[]>(
        `/api/addresses/by-type/${tipo}?usuarioId=${usuarioId}`
      );
    } catch (error: unknown) {
      const errorMessage =
        error instanceof Error
          ? error.message
          : "Error obteniendo direcciones por tipo";
      throw new Error(errorMessage);
    }
  }

  /**
   * Obtiene la dirección predeterminada por tipo
   */
  public async getDefaultAddress(
    tipo: "ENVIO" | "FACTURACION" | "AMBOS"
  ): Promise<Address | null> {
    try {
      const kioskUser = this.getKioskUserId();
      if (!kioskUser) {
        console.warn(
          "No hay información de usuario para obtener dirección predeterminada"
        );
        return null;
      }
      const endpoint = `/api/addresses/default/${tipo}?usuarioId=${encodeURIComponent(
        kioskUser.userId
      )}`;

      return await apiGet<Address>(endpoint);
    } catch {
      return null;
    }
  }

  /**
   * Actualiza una dirección existente
   */
  public async updateAddress(
    addressId: string,
    updateData: Partial<CreateAddressRequest>
  ): Promise<Address> {
    try {
      return await apiPut<Address>(`/api/addresses/${addressId}`, updateData);
    } catch (error: unknown) {
      const errorMessage =
        error instanceof Error ? error.message : "Error actualizando dirección";
      throw new Error(errorMessage);
    }
  }

  /**
   * Desactiva una dirección
   */
  public async deactivateAddress(
    addressId: string
  ): Promise<{ message: string }> {
    try {
      return await apiDelete<{ message: string }>(
        `/api/addresses/${addressId}`
      );
    } catch (error: unknown) {
      const errorMessage =
        error instanceof Error ? error.message : "Error desactivando dirección";
      throw new Error(errorMessage);
    }
  }

  /**
   * Elimina físicamente una dirección de usuario
   * Si la dirección eliminada era predeterminada, establece otra dirección como predeterminada automáticamente
   * @param addressId - ID de la dirección a eliminar
   * @returns Mensaje de confirmación
   */
  public async deleteAddress(addressId: string): Promise<{ message: string }> {
    try {
      const kioskUser = this.getKioskUserId();
      if (!kioskUser) {
        throw new Error(
          "No se encontró información del usuario. Por favor, inicia sesión nuevamente."
        );
      }
      const usuarioId = kioskUser.userId;

      // Obtener todas las direcciones antes de eliminar para verificar si la eliminada era predeterminada
      const allAddresses = await this.getUserAddresses();
      const addressToDelete = allAddresses.find(
        (addr) => addr.id === addressId
      );
      const wasDefault = addressToDelete?.esPredeterminada || false;
      const totalAddresses = allAddresses.length;

      // Eliminar la dirección
      const endpoint = `/api/addresses/${addressId}?usuarioId=${encodeURIComponent(
        usuarioId
      )}`;

      console.log("🗑️ Eliminando dirección:", {
        addressId,
        usuarioId,
        endpoint,
        wasDefault,
        totalAddresses,
      });

      const result = await apiDelete<{ message: string }>(endpoint);

      // Si la dirección eliminada era predeterminada y quedan otras direcciones, establecer una nueva como predeterminada
      // Si no hay más direcciones, simplemente se elimina y ya está
      if (wasDefault && totalAddresses > 1) {
        // Obtener las direcciones restantes después de la eliminación
        const remainingAddresses = allAddresses.filter(
          (addr) => addr.id !== addressId
        );

        if (remainingAddresses.length > 0) {
          // Buscar la primera dirección disponible que no sea la eliminada
          const newDefaultAddress = remainingAddresses[0];

          try {
            console.log(
              `🔄 Estableciendo nueva dirección predeterminada: ${newDefaultAddress.id} (${newDefaultAddress.nombreDireccion})`
            );
            const updatedAddress = await this.setDefaultAddress(
              newDefaultAddress.id
            );
            console.log(
              `✅ Nueva dirección predeterminada establecida en la base de datos:`,
              {
                id: updatedAddress.id,
                nombreDireccion: updatedAddress.nombreDireccion,
                esPredeterminada: updatedAddress.esPredeterminada,
              }
            );
          } catch (setDefaultError) {
            console.error(
              "⚠️ Error estableciendo nueva dirección predeterminada:",
              setDefaultError
            );
            // Re-lanzar el error para que el usuario sepa que hubo un problema
            throw new Error(
              `La dirección fue eliminada, pero hubo un error al establecer otra como predeterminada: ${
                setDefaultError instanceof Error
                  ? setDefaultError.message
                  : "Error desconocido"
              }`
            );
          }
        }
      } else if (totalAddresses === 1) {
        // Si era la única dirección, simplemente se elimina y ya está
        console.log(
          "ℹ️ Se eliminó la última dirección. No hay más direcciones para establecer como predeterminada."
        );
      }

      return result;
    } catch (error: unknown) {
      const errorMessage =
        error instanceof Error ? error.message : "Error eliminando dirección";
      throw new Error(errorMessage);
    }
  }

  /**
   * Incrementa el contador de uso de una dirección
   */
  public async incrementUsageCount(
    addressId: string
  ): Promise<{ message: string }> {
    try {
      return await apiPost<{ message: string }>(
        `/api/addresses/${addressId}/increment-usage`,
        {}
      );
    } catch (error: unknown) {
      const errorMessage =
        error instanceof Error
          ? error.message
          : "Error incrementando contador de uso";
      throw new Error(errorMessage);
    }
  }

  /**
   * Crea una nueva dirección SIN establecerla como predeterminada
   * Útil para agregar direcciones de facturación desde Step6 sin afectar
   * la dirección predeterminada actual
   */
  public async createAddressWithoutDefault(
    addressData: CreateAddressRequest
  ): Promise<Address> {
    try {
      const requestData = { ...addressData };

      // Usar getKioskUserId para obtener el userId correcto (incluye kiosk_client_id)
      const kioskUser = this.getKioskUserId();
      if (kioskUser) {
        requestData.usuarioId = kioskUser.userId;
        console.log(`✅ createAddressWithoutDefault: Usando ${kioskUser.source}: ${kioskUser.userId}`);
      } else {
        throw new Error(
          "No se encontró información del usuario. Por favor, inicia sesión nuevamente."
        );
      }

      // Forzar esPredeterminada a false para no afectar la dirección actual
      requestData.esPredeterminada = false;

      console.log("📤 [createAddressWithoutDefault] Creando dirección sin establecer como default:", {
        ...requestData,
        placeDetails: requestData.placeDetails ? "PlaceDetails object" : "null",
      });

      const result = await apiPost<Address>("/api/addresses", requestData);
      console.log("✅ [createAddressWithoutDefault] Dirección creada exitosamente (NO es default):", result);

      // NO llamar a setDefaultAddress - retornar directamente
      return result;
    } catch (error: unknown) {
      console.error("❌ Error creando dirección (sin default):", error);
      const errorMessage =
        error instanceof Error
          ? error.message
          : "Error desconocido creando dirección";
      throw new Error(errorMessage);
    }
  }

  /**
   * Establece una dirección como predeterminada
   * Desmarca otras direcciones predeterminadas del mismo tipo automáticamente
   *
   * @param addressId - ID de la dirección a establecer como predeterminada
   * @returns Dirección actualizada
   */
  public async setDefaultAddress(addressId: string): Promise<Address> {
    try {
      const kioskUser = this.getKioskUserId();
      console.log("🔑 setDefaultAddress:", { addressId, ...kioskUser });

      if (!kioskUser) {
        throw new Error(
          "No se encontró información del usuario. Por favor, inicia sesión nuevamente."
        );
      }
      const usuarioId = kioskUser.userId;
      const endpoint = `/api/addresses/${addressId}/set-default?usuarioId=${encodeURIComponent(
        usuarioId
      )}`;

      const result = await apiPost<Address>(endpoint, {});
      console.log("✅ setDefaultAddress exitoso:", { addressId, usuarioId });
      return result;
    } catch (error: unknown) {
      const errorMessage =
        error instanceof Error
          ? error.message
          : "Error estableciendo dirección predeterminada";
      throw new Error(errorMessage);
    }
  }
}

// Exportar instancia única
export const addressesService = AddressesService.getInstance();
