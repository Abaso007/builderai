"use client"

import createGlobe, { type COBEOptions } from "cobe"
import { motion, useAnimation, useMotionValue, useSpring } from "framer-motion"
import { useEffect, useRef, useState } from "react"

import { cn } from "@unprice/ui/utils"
import { useTheme } from "next-themes"
import useIntersectionObserver from "../../hooks/use-intersection-observer"

const MOVEMENT_DAMPING = 1400

const GLOBE_CONFIG: COBEOptions = {
  width: 900,
  height: 900,
  onRender: () => {},
  devicePixelRatio: 2,
  phi: 0,
  theta: 0.3,
  dark: 0,
  diffuse: 0.4,
  mapSamples: 25000,
  mapBrightness: 5,
  baseColor: [1, 1, 1],
  markerColor: [255 / 255, 197 / 255, 61 / 255],
  glowColor: [0.5, 0.5, 0.5],
  markers: [
    { location: [14.5995, 120.9842], size: 0.03 },
    { location: [19.076, 72.8777], size: 0.1 },
    { location: [23.8103, 90.4125], size: 0.05 },
    { location: [30.0444, 31.2357], size: 0.07 },
    { location: [39.9042, 116.4074], size: 0.08 },
    { location: [-23.5505, -46.6333], size: 0.1 },
    { location: [19.4326, -99.1332], size: 0.1 },
    { location: [40.7128, -74.006], size: 0.1 },
    { location: [34.6937, 135.5022], size: 0.05 },
    { location: [41.0082, 28.9784], size: 0.06 },
  ],
}

export function Globe({
  className,
  config = GLOBE_CONFIG,
}: {
  className?: string
  config?: COBEOptions
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const pointerInteracting = useRef<number | null>(null)
  const pointerInteractionMovement = useRef(0)
  const globeInstance = useRef<ReturnType<typeof createGlobe> | null>(null)
  const { resolvedTheme } = useTheme()
  const [mounted, setMounted] = useState(false)

  useEffect(() => {
    setMounted(true)
  }, [])

  const entry = useIntersectionObserver(containerRef, {
    threshold: 0.1,
    rootMargin: "50px",
  })
  const isVisible = !!entry?.isIntersecting

  const controls = useAnimation()
  const r = useMotionValue(0)
  const rs = useSpring(r, {
    mass: 1,
    damping: 30,
    stiffness: 100,
  })

  const updatePointerInteraction = (value: number | null) => {
    pointerInteracting.current = value
    if (canvasRef.current) {
      canvasRef.current.style.cursor = value !== null ? "grabbing" : "grab"
    }
  }

  const updateMovement = (clientX: number) => {
    if (pointerInteracting.current !== null) {
      const delta = clientX - pointerInteracting.current
      pointerInteractionMovement.current = delta
      r.set(r.get() + delta / MOVEMENT_DAMPING)
    }
  }

  useEffect(() => {
    if (!mounted || !isVisible || !canvasRef.current) return

    let phi = 0
    let width = 0

    const onResize = () => {
      if (canvasRef.current) {
        width = canvasRef.current.offsetWidth
      }
    }

    window.addEventListener("resize", onResize)
    onResize()

    if (globeInstance.current) {
      globeInstance.current.destroy()
    }

    const theme = resolvedTheme || "dark"

    globeInstance.current = createGlobe(canvasRef.current, {
      ...config,
      width: width * 2,
      height: width * 2,
      scale: width < 480 ? 1.5 : 1.1,
      baseColor: theme === "dark" ? [0.1, 0.1, 0.1] : [1, 1, 1],
      markerColor:
        theme === "dark" ? [255 / 255, 200 / 255, 100 / 255] : [255 / 255, 197 / 255, 61 / 255],
      glowColor: theme === "dark" ? [0.1, 0.1, 0.1] : [0.5, 0.5, 0.5],
      dark: theme === "dark" ? 1 : 0,
      mapBrightness: theme === "dark" ? 10 : 6,
      diffuse: theme === "dark" ? 1.2 : 0.4,
      onRender: (state) => {
        if (!pointerInteracting.current) phi += 0.005
        state.phi = phi + rs.get()
        state.width = width * 2
        state.height = width * 2
      },
    })

    controls.start({
      opacity: 1,
      scale: 1,
      transition: { duration: 1, ease: "easeOut" },
    })

    return () => {
      if (globeInstance.current) {
        globeInstance.current.destroy()
      }
      window.removeEventListener("resize", onResize)
    }
  }, [mounted, isVisible, rs, config, controls, resolvedTheme])

  return (
    <motion.div
      ref={containerRef}
      className={cn("relative aspect-square w-full", className)}
      initial={{ opacity: 0, scale: 0.9 }}
      animate={controls}
    >
      <canvas
        className={cn(
          "size-full touch-none transition-opacity duration-500 [contain:layout_paint_size]",
          !isVisible ? "opacity-0" : "opacity-100"
        )}
        style={{
          maskImage: "radial-gradient(circle at center, white 50%, transparent 100%)",
          WebkitMaskImage: "radial-gradient(circle at center, white 50%, transparent 100%)",
        }}
        ref={canvasRef}
        onPointerDown={(e) => {
          pointerInteracting.current = e.clientX
          updatePointerInteraction(e.clientX)
        }}
        onPointerUp={() => updatePointerInteraction(null)}
        onPointerOut={() => updatePointerInteraction(null)}
        onPointerMove={(e) => updateMovement(e.clientX)}
      />
    </motion.div>
  )
}
