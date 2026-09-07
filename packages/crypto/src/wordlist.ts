/**
 * Fingerprint wordlist (§11).
 *
 * 256 short, visually distinct nouns — one byte each, so a 4-word fingerprint
 * encodes exactly 32 bits. Words were chosen to be pronounceable and unlikely
 * to be confused when read aloud over a phone call, which is the actual use
 * case: comparing a capsule's fingerprint through a second channel.
 *
 * The list is intentionally frozen. Changing an entry changes every
 * fingerprint, so it is versioned with the envelope.
 */

export const FINGERPRINT_WORDS: readonly string[] = Object.freeze([
  'abeto', 'ancla', 'arena', 'arpa', 'astro', 'atlas', 'aurora', 'avena',
  'bahia', 'balsa', 'bambu', 'barro', 'basalto', 'bisonte', 'brisa', 'bronce',
  'cabo', 'cactus', 'caleta', 'canela', 'cantera', 'carbon', 'cardo', 'cascada',
  'cedro', 'ceniza', 'cerezo', 'cesped', 'cielo', 'cifra', 'cima', 'cobre',
  'coral', 'corcho', 'cordel', 'cresta', 'cristal', 'cuarzo', 'cumbre', 'cuervo',
  'delta', 'dique', 'dorado', 'duna', 'ebano', 'eclipse', 'estano', 'estepa',
  'faro', 'fiordo', 'flecha', 'follaje', 'fosil', 'fresno', 'fuente', 'fulgor',
  'galena', 'ganso', 'garza', 'geiser', 'glaciar', 'granito', 'grulla', 'guijarro',
  'halcon', 'helecho', 'hielo', 'hierro', 'hoguera', 'hongo', 'horizonte', 'huella',
  'iceberg', 'iman', 'indigo', 'invierno', 'isla', 'jade', 'jaguar', 'jazmin',
  'junco', 'kelp', 'laguna', 'lampara', 'lanza', 'lastre', 'laurel', 'lava',
  'lienzo', 'limo', 'linterna', 'liquen', 'llanura', 'lluvia', 'lobo', 'loma',
  'lonja', 'luciernaga', 'lumbre', 'luna', 'macizo', 'madera', 'malaquita', 'mangle',
  'marea', 'marfil', 'margen', 'menta', 'meseta', 'mica', 'miel', 'mirlo',
  'mistral', 'monzon', 'morena', 'muelle', 'musgo', 'nacar', 'nave', 'nebula',
  'nevada', 'niebla', 'nieve', 'nispero', 'nomada', 'nopal', 'norte', 'nube',
  'obsidiana', 'ocaso', 'ocre', 'oleaje', 'olivo', 'onix', 'orquidea', 'ostra',
  'otono', 'pajar', 'palma', 'pampa', 'panal', 'pantano', 'papiro', 'paramo',
  'pedernal', 'penasco', 'perla', 'petrel', 'pinar', 'pino', 'pizarra', 'plata',
  'playa', 'pluma', 'polar', 'polen', 'pomelo', 'portal', 'pradera', 'puerto',
  'pulpo', 'quebrada', 'quilla', 'quimera', 'rafaga', 'raiz', 'rama', 'rambla',
  'rapida', 'rastro', 'recodo', 'redil', 'reflejo', 'regato', 'relieve', 'remanso',
  'resina', 'retama', 'ribera', 'risco', 'roble', 'rocio', 'romero', 'rubi',
  'sabana', 'salina', 'salmon', 'sauce', 'savia', 'secuoya', 'selva', 'sendero',
  'serpiente', 'sierra', 'silice', 'sirena', 'solano', 'sombra', 'sonda', 'sotobosque',
  'suelo', 'surco', 'talud', 'tambor', 'tejo', 'tempano', 'terraza', 'tiza',
  'tomillo', 'topacio', 'tordo', 'tormenta', 'torre', 'tortuga', 'trebol', 'trigo',
  'trueno', 'tundra', 'turba', 'turmalina', 'umbral', 'urraca', 'vaguada', 'valle',
  'vapor', 'varal', 'vega', 'vela', 'venero', 'ventisca', 'verano', 'vereda',
  'vertiente', 'vidrio', 'viento', 'vinedo', 'violeta', 'vision', 'vistoso', 'volcan',
  'yacimiento', 'yedra', 'yema', 'yeso', 'yunque', 'zafiro', 'zaguan', 'zarza',
  'zinc', 'zorro', 'zumaque', 'zurron', 'abanico', 'abismo', 'acacia', 'acantilado',
]);

if (FINGERPRINT_WORDS.length !== 256) {
  // A wrong-sized list would silently bias fingerprints; fail loudly at import.
  throw new Error(`fingerprint wordlist must hold 256 entries, found ${FINGERPRINT_WORDS.length}`);
}
