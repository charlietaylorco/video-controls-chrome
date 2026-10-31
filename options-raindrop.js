(() => {
  const tokenInput = document.getElementById('raindrop-token');
  const tagsInput = document.getElementById('raindrop-tags');
  const collectionInput = document.getElementById('raindrop-collection');
  const refreshButton = document.getElementById('refresh-raindrop-collections');
  const tokenButton = document.getElementById('save-raindrop-token');
  const output = document.getElementById('raindrop-settings-status');
  let token = '', tags = [], collectionId = -1, loadId = 0;
  const normalizeTags = value => [...new Set(value.split(',').map(tag => tag.trim()).filter(Boolean))];
  const option = (value, label) => {
    const node = document.createElement('option');
    node.value = String(value); node.textContent = label;
    return node;
  };
  const renderCollections = (items = []) => {
    const byId = new Map(items.map(item => [item._id, item]));
    const label = item => {
      const names = [item.title], seen = new Set([item._id]);
      let parent = byId.get(item.parent?.$id);
      while (parent && !seen.has(parent._id)) {
        seen.add(parent._id); names.unshift(parent.title); parent = byId.get(parent.parent?.$id);
      }
      return names.join(' / ');
    };
    const sorted = items.map(item => ({ id: item._id, label: label(item) }))
      .sort((a, b) => a.label.localeCompare(b.label));
    collectionInput.replaceChildren(option(-1, 'Unsorted (default)'), ...sorted.map(item => option(item.id, item.label)));
    // Preserve the saved destination if loading fails or it is no longer returned.
    // Changing it to Unsorted must be an explicit choice.
    if (collectionId > 0 && !byId.has(collectionId)) {
      collectionInput.append(option(collectionId, `Saved collection (#${collectionId}) — unavailable`));
    }
    collectionInput.value = String(collectionId);
  };
  const loadCollections = async () => {
    const requestId = ++loadId;
    refreshButton.disabled = true;
    if (!token) {
      renderCollections();
      output.textContent = 'Save your API token to load collections. Tags and Unsorted work without loading collections.';
      return;
    }
    output.textContent = 'Loading collections…';
    try {
      const lists = await Promise.all(['collections', 'collections/childrens'].map(async endpoint => {
        const response = await fetch(`https://api.raindrop.io/rest/v1/${endpoint}`, {
          headers: { Authorization: `Bearer ${token}` }, redirect: 'error', signal: AbortSignal.timeout(15000)
        });
        if (!response.ok) throw new Error([401, 403].includes(response.status) ? 'token' : 'load');
        const data = await response.json();
        if (data.result !== true || !Array.isArray(data.items)) throw new Error('load');
        return data.items;
      }));
      if (requestId !== loadId) return;
      const items = [...new Map(lists.flat().filter(item => Number.isSafeInteger(item?._id) && item._id > 0 && typeof item.title === 'string')
        .map(item => [item._id, item])).values()];
      renderCollections(items);
      output.textContent = collectionId > 0 && !items.some(item => item._id === collectionId)
        ? 'Your saved collection is unavailable. Choose another collection if it was deleted or access changed.'
        : 'Collections loaded. Tags and collection apply to future extension saves.';
    } catch (error) {
      if (requestId !== loadId) return;
      output.textContent = error.message === 'token'
        ? 'Could not load collections. Check and save your API token, then refresh. Your saved destination is kept.'
        : 'Could not load collections. Try Refresh collections. Your saved destination is kept.';
    } finally {
      if (requestId === loadId) refreshButton.disabled = !token;
    }
  };
  chrome.storage.local.get({ raindropToken: '', raindropTags: [], raindropCollectionId: -1 }, values => {
    if (chrome.runtime.lastError) { output.textContent = 'Could not load Raindrop settings. Reopen this page to try again.'; return; }
    token = typeof values.raindropToken === 'string' ? values.raindropToken.trim() : '';
    tags = Array.isArray(values.raindropTags) ? normalizeTags(values.raindropTags.filter(tag => typeof tag === 'string').join(',')) : [];
    collectionId = Number.isSafeInteger(values.raindropCollectionId) && values.raindropCollectionId > 0 ? values.raindropCollectionId : -1;
    tokenInput.value = token; tagsInput.value = tags.join(', ');
    tagsInput.disabled = false; collectionInput.disabled = false;
    renderCollections();
    void loadCollections();
  });
  tagsInput.addEventListener('change', () => {
    const next = normalizeTags(tagsInput.value);
    chrome.storage.local.set({ raindropTags: next }, () => {
      if (!chrome.runtime.lastError) tags = next;
      tagsInput.value = tags.join(', ');
      showStatus(chrome.runtime.lastError ? 'Could not save Raindrop tags' : 'Raindrop tags saved');
    });
  });
  collectionInput.addEventListener('change', () => {
    const next = Number(collectionInput.value);
    if (!Number.isSafeInteger(next) || (next !== -1 && next <= 0)) return;
    chrome.storage.local.set({ raindropCollectionId: next }, () => {
      if (!chrome.runtime.lastError) collectionId = next;
      collectionInput.value = String(collectionId);
      showStatus(chrome.runtime.lastError ? 'Could not save Raindrop collection' : 'Raindrop collection saved');
    });
  });
  const saveToken = () => {
    const next = tokenInput.value.trim();
    tokenButton.disabled = true;
    chrome.storage.local.set({ raindropToken: next }, () => {
      tokenButton.disabled = false;
      showStatus(chrome.runtime.lastError ? 'Could not save Raindrop token' : 'Raindrop token saved');
      if (chrome.runtime.lastError) return;
      token = next; tokenInput.value = token;
      // Discard choices loaded with the previous credentials before refreshing.
      renderCollections();
      void loadCollections();
    });
  };
  tokenButton.addEventListener('click', saveToken);
  tokenInput.addEventListener('keydown', event => {
    if (event.key === 'Enter') { event.preventDefault(); if (!tokenButton.disabled) saveToken(); }
  });
  refreshButton.addEventListener('click', () => { void loadCollections(); });
})();
