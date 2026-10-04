(function () {
	const storageKey = 'vapewave-campaign-tracking';
	const trackingKeys = [
		'utm_source',
		'utm_medium',
		'utm_campaign',
		'utm_term',
		'utm_content',
		'utm_id',
		'campaign_id',
		'adset_id',
		'ad_id',
		'fbclid',
		'gclid',
		'gbraid',
		'wbraid',
		'ttclid'
	];
	const now = Date.now();
	const currentTracking = {};
	const query = new URLSearchParams(window.location.search);

	trackingKeys.forEach(function (key) {
		const value = query.get(key);
		if (value) currentTracking[key] = value.trim();
	});

	let tracking = currentTracking;
	if (Object.keys(currentTracking).length) {
		try {
			localStorage.setItem(storageKey, JSON.stringify({
				expiresAt: now + 30 * 24 * 60 * 60 * 1000,
				values: currentTracking
			}));
		} catch (error) {
			console.warn('Não foi possível salvar os parâmetros de campanha', error);
		}
	} else {
		try {
			const stored = JSON.parse(localStorage.getItem(storageKey) || 'null');
			if (stored && stored.expiresAt > now && stored.values && typeof stored.values === 'object' && !Array.isArray(stored.values)) {
				trackingKeys.forEach(function (key) {
					if (typeof stored.values[key] === 'string' && stored.values[key]) {
						tracking[key] = stored.values[key];
					}
				});
			}
		} catch (error) {
			console.warn('Não foi possível recuperar os parâmetros de campanha', error);
		}
	}

	window.vapewaveGetCampaignTracking = function () {
		return Object.assign({}, tracking);
	};
})();
