export function buildFeatureConfig() {
  const topLevel = {
    featureFlag: false,
    owner: 'top-level',
    notes: [
      'first duplicate section',
      'used to simulate wrong anchoring',
    ],
  };

  const services = [
    {
      name: 'alpha',
      enabled: true,
    },
    {
      name: 'beta',
      enabled: true,
    },
    {
      name: 'gamma',
      enabled: true,
      featureFlag: false,
      owner: 'nested-target',
      notes: [
        'second duplicate section',
        'this is the intended review anchor',
      ],
    },
  ];

  return {
    topLevel,
    services,
  };
}
