/**
 * @module AddressAutocomplete
 * @description Componente de autocompletado de direcciones para Colombia
 * Implementa los principios SOLID y está optimizado para el mercado colombiano
 */

'use client';

import React, { useState, useRef, useEffect, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { Search, MapPin, AlertCircle, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  AddressAutocompleteProps,
  PlacePrediction,
  AutocompleteOptions,
  PlaceType
} from '@/types/places.types';
import { usePlacesAutocomplete } from '@/hooks/usePlacesAutocomplete';

/**
 * Componente de autocompletado de direcciones
 * Optimizado para direcciones colombianas con validación de cobertura
 */
export function AddressAutocomplete({
  value = '',
  addressType,
  onPlaceSelect,
  onChange,
  placeholder = 'Escribe tu dirección...',
  className = '',
  required = false,
  disabled = false,
  error: externalError,
  label,
  options,
  clearOnSelect = false,
  showSearchIcon = true,
  validateCoverage = false,
  enableAutoSelect = false
}: AddressAutocompleteProps & { enableAutoSelect?: boolean }) {
  // Estado local del componente
  const [isOpen, setIsOpen] = useState(false);
  const [isMounted, setIsMounted] = useState(false);
  const [dropdownPosition, setDropdownPosition] = useState({ top: 0, left: 0, width: 0 });
  const [justSelected, setJustSelected] = useState(false);

  // Referencias para el manejo del DOM
  const inputRef = useRef<HTMLInputElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Opciones por defecto optimizadas para Colombia
  const defaultOptions: AutocompleteOptions = useMemo(() => ({
    countryRestriction: 'CO',
    language: 'es',
    minLength: 3,
    debounceTime: 300,
    maxResults: 5,
    location: {
      lat: 4.570868, // Bogotá como centro de Colombia
      lng: -74.297333
    },
    radius: 1000000, // Cubrir todo Colombia
    types: [PlaceType.GEOCODE, PlaceType.ADDRESS],
    ...options
  }), [options]);

  // Cobertura desactivada - se permite cualquier dirección
  const shouldValidateCoverage = false;

  // Hook de autocompletado
  const {
    inputValue,
    setInputValue,
    selectPlace,
    clearResults,
    reset,
    isLoading,
    predictions,
    selectedPlace,
    error: hookError
  } = usePlacesAutocomplete({
    options: defaultOptions,
    onPlaceSelect: (place) => {
      // Asegurar que el dropdown esté cerrado
      setIsOpen(false);
      onPlaceSelect?.(place);
      if (clearOnSelect) {
        reset();
      }
    },
    onError: (error) => {
      console.error('Error en autocompletado:', error);
      // Cerrar dropdown incluso si hay error
      setIsOpen(false);
    },
    validateCoverage: shouldValidateCoverage
  });

  // Error combinado (externo o del hook)
  const error = externalError || hookError;

  /**
   * Maneja el cambio en el input
   */
  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const newValue = e.target.value;
    setInputValue(newValue);
    onChange?.(newValue);

    // Abrir dropdown si hay texto
    if (newValue.trim()) {
      setIsOpen(true);
    } else {
      setIsOpen(false);
      clearResults();
    }
  };

  /**
   * Maneja la selección de una predicción
   */
  const handlePredictionSelect = async (prediction: PlacePrediction) => {
    // Marcar que acabamos de seleccionar para evitar que se abra el dropdown
    setJustSelected(true);
    // Cerrar dropdown inmediatamente al seleccionar
    setIsOpen(false);
    // Limpiar resultados para evitar que reaparezcan
    clearResults();
    await selectPlace(prediction);

    // Limpiar el flag después de un momento
    setTimeout(() => {
      setJustSelected(false);
    }, 500);
  };

  /**
   * Maneja el focus del input
   */
  const handleFocus = () => {
    if (predictions.length > 0 && inputValue.trim()) {
      setIsOpen(true);
    }
  };

  /**
   * Maneja la pérdida de focus
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const handleBlur = (_e: React.FocusEvent) => {
    // Cerrar dropdown con delay para permitir clicks en predicciones
    setTimeout(() => {
      if (!containerRef.current?.contains(document.activeElement)) {
        setIsOpen(false);
      }
    }, 150);
  };

  /**
   * Maneja el teclado
   */
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      setIsOpen(false);
      inputRef.current?.blur();
    }
  };


  /**
   * Inicializa el input con el valor externo
   */
  const prevValueRef = useRef<string>('');
  useEffect(() => {
    // Solo actualizar si el valor externo cambió y es diferente del valor actual del input
    if (value !== undefined && value !== '' && value !== prevValueRef.current) {
      setInputValue(value);
      prevValueRef.current = value;
      // No abrir dropdown aquí - dejar que el hook haga la búsqueda
    }
  }, [value, setInputValue]);

  /**
   * Detectar si estamos en el cliente
   */
  useEffect(() => {
    setIsMounted(true);
  }, []);

  /**
   * Actualizar posición del dropdown cuando se abre
   * IMPORTANTE: NO usar window.scrollY porque el dropdown se renderiza con position: fixed
   * y getBoundingClientRect() ya devuelve la posición relativa al viewport
   */
  useEffect(() => {
    if (isOpen && inputRef.current && isMounted) {
      let anterior = '';
      const updatePosition = () => {
        const rect = inputRef.current?.getBoundingClientRect();
        if (!rect) return;

        // Alto visible real: con el teclado abierto, visualViewport es bastante
        // menor que window.innerHeight.
        const altoVisible = window.visualViewport?.height ?? window.innerHeight;
        const espacioAbajo = altoVisible - rect.bottom;
        const alto = dropdownRef.current?.offsetHeight ?? 240;
        // Si abajo no cabe (teclado), se abre hacia arriba del campo.
        const arriba = espacioAbajo < Math.min(alto, 160) && rect.top > espacioAbajo;

        const pos = {
          top: arriba ? Math.max(8, rect.top - alto - 4) : rect.bottom + 4,
          left: rect.left,
          width: rect.width
        };
        const clave = `${Math.round(pos.top)}|${Math.round(pos.left)}|${Math.round(pos.width)}`;
        if (clave !== anterior) {
          anterior = clave;
          setDropdownPosition(pos);
        }
      };

      // iOS no dispara scroll/resize de forma fiable al abrir el teclado: mientras
      // la lista está abierta se recalcula en cada frame (dura solo unos segundos).
      let frame = 0;
      const bucle = () => {
        updatePosition();
        frame = window.requestAnimationFrame(bucle);
      };
      bucle();

      // Actualizar posición al hacer scroll o resize
      window.addEventListener('scroll', updatePosition, true);
      window.addEventListener('resize', updatePosition);
      window.visualViewport?.addEventListener('resize', updatePosition);
      window.visualViewport?.addEventListener('scroll', updatePosition);

      return () => {
        window.cancelAnimationFrame(frame);
        window.removeEventListener('scroll', updatePosition, true);
        window.removeEventListener('resize', updatePosition);
        window.visualViewport?.removeEventListener('resize', updatePosition);
        window.visualViewport?.removeEventListener('scroll', updatePosition);
      };
    }
  }, [isOpen, isMounted]);

  /**
   * Abrir dropdown cuando hay predicciones disponibles
   * SOLO si no acabamos de seleccionar una opción
   * Y SELECCIONAR AUTOMÁTICAMENTE LA PRIMERA OPCIÓN (Si está habilitado)
   */
  useEffect(() => {
    if (predictions.length > 0 && inputValue.trim() && !isLoading && !justSelected) {
      setIsOpen(true);
      
      // Seleccionar automáticamente la primera predicción después de un pequeño delay
      // SOLO SI enableAutoSelect es true
      if (enableAutoSelect) {
        const autoSelectTimer = setTimeout(() => {
          if (predictions.length > 0 && !selectedPlace) {
            const firstPrediction = predictions[0];
            setJustSelected(true);
            setIsOpen(false);
            clearResults();
            selectPlace(firstPrediction);
            
            // Limpiar el flag después de un momento
            setTimeout(() => {
              setJustSelected(false);
            }, 500);
          }
        }, 800); // Dar 800ms para que el usuario pueda ver las opciones y hacer click manualmente
        
        return () => clearTimeout(autoSelectTimer);
      }
    }
  }, [predictions, inputValue, isLoading, justSelected, selectedPlace, selectPlace, clearResults, enableAutoSelect]);

  /**
   * Efecto para cerrar dropdown al hacer click fuera
   * IMPORTANTE: Verificar tanto containerRef como dropdownRef porque el dropdown
   * se renderiza con portal en document.body (fuera de containerRef)
   */
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      const isClickInContainer = containerRef.current?.contains(event.target as Node);
      const isClickInDropdown = dropdownRef.current?.contains(event.target as Node);

      // Solo cerrar si el click NO está en el container NI en el dropdown
      if (!isClickInContainer && !isClickInDropdown) {
        setIsOpen(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Clases CSS dinámicas
  const inputClasses = cn(
    'w-full px-4 py-3 text-base bg-white border-2 rounded-lg transition-all duration-200',
    'placeholder:text-gray-400 focus:outline-none focus:ring-0',
    'disabled:bg-gray-50 disabled:text-gray-500 disabled:cursor-not-allowed',
    {
      'border-gray-200 focus:border-blue-500': !error,
      'border-red-300 focus:border-red-500': error,
      'pl-12': showSearchIcon,
      'pr-10': isLoading
    },
    className
  );

  const dropdownClasses = cn(
    'fixed z-[200000] bg-white border border-gray-200 rounded-lg shadow-lg pointer-events-auto',
    'max-h-60 overflow-y-auto scrollbar-thin scrollbar-thumb-gray-300',
    {
      'border-red-300': error
    }
  );

  // top ya viene calculado (incluye el desplazamiento y el caso "hacia arriba")
  const dropdownStyles = {
    top: `${dropdownPosition.top}px`,
    left: `${dropdownPosition.left}px`,
    width: `${dropdownPosition.width}px`
  };

  return (
    <div ref={containerRef} className="relative w-full">
      {/* Label */}
      {label && (
        <label className="block text-sm font-medium text-gray-700 mb-2">
          {label}
          {required && <span className="text-red-500 ml-1">*</span>}
        </label>
      )}

      {/* Input Container */}
      <div className="relative">
        {/* Ícono de búsqueda */}
        {showSearchIcon && (
          <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
            <Search className="h-5 w-5 text-gray-400" />
          </div>
        )}

        {/* Input */}
        <input
          ref={inputRef}
          type="text"
          value={inputValue}
          onChange={handleInputChange}
          onFocus={handleFocus}
          onBlur={handleBlur}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          disabled={disabled}
          required={required}
          className={inputClasses}
          autoComplete="off"
          role="combobox"
          aria-label={label || 'Dirección'}
          aria-expanded={isOpen}
          aria-haspopup="listbox"
          aria-controls="address-listbox"
          aria-describedby={error ? `${label}-error` : undefined}
        />

        {/* Indicadores del lado derecho */}
        <div className="absolute inset-y-0 right-0 flex items-center pr-3">
          {isLoading && (
            <Loader2 className="h-5 w-5 text-gray-400 animate-spin" />
          )}
        </div>
      </div>

      {/* Dropdown de predicciones - renderizado con portal */}
      {isMounted && isOpen && predictions.length > 0 && createPortal(
        <div ref={dropdownRef} className={dropdownClasses} style={dropdownStyles}>
          <ul role="listbox" id="address-listbox" className="py-1">
            {/* eslint-disable-next-line @typescript-eslint/no-unused-vars */}
            {predictions.map((prediction, _index) => (
              <li
                key={prediction.placeId}
                role="option"
                aria-selected="false"
                className="px-4 py-3 hover:bg-gray-50 cursor-pointer border-b border-gray-100 last:border-0 transition-colors"
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  handlePredictionSelect(prediction);
                }}
              >
                <div className="flex items-start space-x-3">
                  <MapPin className="h-5 w-5 text-gray-400 mt-0.5 flex-shrink-0" />
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium text-gray-900 truncate">
                      {prediction.structuredFormatting?.mainText || prediction.mainText}
                    </div>
                    <div className="text-sm text-gray-500 truncate">
                      {prediction.structuredFormatting?.secondaryText || prediction.secondaryText}
                    </div>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </div>,
        document.body
      )}

      {/* Estado vacío cuando se busca pero no hay resultados - renderizado con portal */}
      {isMounted && isOpen && !isLoading && predictions.length === 0 && inputValue.trim() && createPortal(
        <div className={dropdownClasses} style={dropdownStyles}>
          <div className="px-4 py-6 text-center text-gray-500">
            <MapPin className="h-8 w-8 mx-auto mb-2 text-gray-300" />
            <p className="text-sm">No se encontraron direcciones</p>
            <p className="text-xs text-gray-400 mt-1">
              Intenta con términos más específicos
            </p>
          </div>
        </div>,
        document.body
      )}

      {/* Mensaje de error */}
      {error && (
        <div className="mt-2 flex items-center space-x-2 text-sm text-red-600">
          <AlertCircle className="h-4 w-4 flex-shrink-0" />
          <span id={`${label}-error`}>{error}</span>
        </div>
      )}
    </div>
  );
}

// Export default para compatibilidad con imports antiguos
export default AddressAutocomplete;