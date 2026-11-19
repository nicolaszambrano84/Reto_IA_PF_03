# Imagen oficial de Bun con versión fija (la misma usada en desarrollo y pruebas).
FROM oven/bun:1.4.5-slim

WORKDIR /app

# Primero las dependencias (capa reutilizable) y solo las de producción, desde el lockfile.
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY . .

# out/ es la única carpeta donde la aplicación escribe. El proceso corre con un usuario sin privilegios.
RUN mkdir -p out && chown -R bun:bun out
USER bun

ENV NODE_ENV=production
EXPOSE 3000
CMD ["bun", "src/server.ts"]
