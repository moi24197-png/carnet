# Carnet

Journal de santé personnel pour téléphone : une note quotidienne, le suivi d'épisodes de blessure, l'évaluation et les prises de traitements, des graphiques et un récapitulatif à montrer en consultation.

Tout est chiffré sur l'appareil. Aucune donnée n'est envoyée sur un serveur : ce dépôt ne contient que le code de l'appli, jamais les données de qui que ce soit.

## Confidentialité et sécurité

| Point | Choix |
|---|---|
| Où sont les données | Dans le stockage local du navigateur de l'appareil, uniquement sous forme chiffrée |
| Chiffrement | AES-256-GCM avec une clé de données aléatoire |
| Accès à la clé | Chiffrée deux fois : par la phrase secrète et par un code de secours de 160 bits, chacun via PBKDF2-SHA256 (600 000 itérations, sel aléatoire) |
| Réseau | Aucune requête vers un tiers : pas de police externe, pas de statistiques, pas de bibliothèque chargée à distance. Une politique de sécurité du contenu (CSP) l'impose |
| Libellés personnels | Le nom du suivi, les zones, les déclencheurs et les contrôles rapides sont réglés dans l'appli et stockés chiffrés. Le code public ne contient que des valeurs génériques |
| Verrouillage | Automatique après 3 minutes d'inactivité. La clé et les données déchiffrées ne vivent qu'en mémoire |
| Sauvegarde | Fichier téléchargé à la demande, chiffré comme le carnet |

Ce que ce modèle ne protège pas : un téléphone compromis par un logiciel malveillant, ou quelqu'un qui utilise le carnet pendant qu'il est déverrouillé. Phrase secrète et code de secours perdus tous les deux signifient données perdues : personne ne peut les récupérer.

## Installation sur Android

1. Ouvrir l'adresse GitHub Pages du dépôt dans Chrome.
2. Menu ⋮, puis « Ajouter à l'écran d'accueil » ou « Installer l'application ».
3. Créer la phrase secrète, noter le code de secours sur papier.
4. Dans Réglages, renseigner ses propres libellés.
5. Ajouter un rappel quotidien dans l'agenda du téléphone.

L'appli fonctionne ensuite hors ligne.

## Sauvegarde et changement de téléphone

- Réglages, puis « Télécharger une sauvegarde » : un fichier `.json` chiffré. Un rappel apparaît sur l'écran du matin après 30 jours sans sauvegarde.
- Sur le nouveau téléphone : écran de verrouillage, « Restaurer une sauvegarde », puis la phrase secrète de la sauvegarde.

## Développement

Aucune dépendance, aucune étape de compilation.

```
python3 -m http.server 8000   # puis http://localhost:8000
node --test tests/*.test.mjs   # tests du chiffrement
```

À chaque modification des fichiers servis, augmenter `VERSION` dans `sw.js` et `APP_VERSION` dans `js/app.js`, pour que les appareils récupèrent la mise à jour.

| Fichier | Rôle |
|---|---|
| `index.html` | Structure des écrans et politique de sécurité du contenu |
| `js/defaults.js` | Valeurs de départ d'un carnet neuf (génériques dans la version publique) |
| `js/crypto.js` | Chiffrement, dérivation des clés, code de secours, validation des sauvegardes |
| `js/app.js` | Interface, saisies, graphiques, récap, réglages |
| `css/app.css` | Styles, thèmes clair et sombre, mise en page d'impression |
| `sw.js` | Mise en cache pour l'usage hors ligne |
| `manifest.webmanifest` | Installation sur l'écran d'accueil |
