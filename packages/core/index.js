// Ré-export des modules servis au front (aucun build step : les fichiers
// vivent dans les assets du Worker et restent la source de vérité unique).
export * from "../../apps/api/public/core.js";
// Couche transport (SPEC §8.3) : sans DOM, donc utilisable telle quelle par
// une future app Expo — c'est ce qui rend la promesse de ce paquet réelle.
export * from "../../apps/api/public/transport.js";
