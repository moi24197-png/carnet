// Valeurs de départ d'un carnet neuf.
// Cette version est volontairement générique : le code est public, il ne doit rien révéler de son utilisateur.
// Les libellés personnels se règlent dans l'appli (Réglages) et sont stockés chiffrés avec les saisies.

export const DEFAULT_SETTINGS = {
  name: "Suivi quotidien",
  zones: ["Visage", "Cou", "Mains", "Bras", "Plis des coudes", "Torse", "Dos", "Jambes", "Creux des genoux", "Pieds"],
  triggers: ["Stress", "Froid", "Chaleur", "Fatigue", "Nuit hors de chez moi", "Aucun identifié"],
  checks: []
};

export const SLEEP_EXTRA = ["Réveillé par les symptômes"];
