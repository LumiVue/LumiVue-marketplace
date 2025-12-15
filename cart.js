// LumiVue Shopping Cart Utility (Firebase compat)
// - Cart stored at: carts/{uid}
// - Fallback: localStorage if Firestore blocked/permissions
// - Also includes wishlist + follow store via buyers/{uid}
//
// REQUIRED scripts in each HTML that uses this file (BEFORE cart.js):
// <script src="https://www.gstatic.com/firebasejs/10.12.0/firebase-app-compat.js"></script>
// <script src="https://www.gstatic.com/firebasejs/10.12.0/firebase-auth-compat.js"></script>
// <script src="https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore-compat.js"></script>
// then:
// <script src="cart.js"></script>

(function () {
  // Firebase Configuration
  const firebaseConfig = {
    apiKey: "AIzaSyAMmOyBqyPr5KoIzqnItE4sH1lb83iQAo8",
    authDomain: "lumivue-c8fdf.firebaseapp.com",
    projectId: "lumivue-c8fdf",
    storageBucket: "lumivue-c8fdf.firebasestorage.app",
    messagingSenderId: "120420036736",
    appId: "1:120420036736:web:0fbbc98b02ea54840d3665"
  };

  // ---- Safe Firebase init (compat) ----
  let firebaseApp = null;
  let auth = null;
  let db = null;

  function ensureFirebase() {
    if (typeof firebase === "undefined") {
      console.error("Firebase SDK not loaded. Include firebase-app-compat, firebase-auth-compat, firebase-firestore-compat.");
      return { firebaseApp: null, auth: null, db: null };
    }

    try {
      if (!firebase.apps || !firebase.apps.length) {
        firebaseApp = firebase.initializeApp(firebaseConfig);
      } else {
        firebaseApp = firebase.app();
      }

      auth = firebase.auth();
      db = firebase.firestore();

      return { firebaseApp, auth, db };
    } catch (e) {
      console.error("Firebase init error:", e);
      return { firebaseApp: null, auth: null, db: null };
    }
  }

  ensureFirebase();

  // ---- Helpers ----
  const LS_CART_KEY = "lv_cart_items_v1"; // namespaced key
  const LS_CART_UPDATED_KEY = "lv_cart_updatedAt_v1";

  function safeJSONParse(str, fallback) {
    try { return JSON.parse(str); } catch { return fallback; }
  }

  function emit(name, detail) {
    try {
      window.dispatchEvent(new CustomEvent(name, { detail: detail || {} }));
    } catch (_) {}
  }

  function nowISO() {
    return new Date().toISOString();
  }

  function normalizePrice(product) {
    // prefer priceNumber, else parse price string
    if (product && product.priceNumber !== undefined && product.priceNumber !== null) {
      const n = Number(product.priceNumber);
      return isFinite(n) ? n : 0;
    }
    const n2 = Number(parseFloat(product?.price));
    return isFinite(n2) ? n2 : 0;
  }

  function normalizeImageUrl(product) {
    // support multiple possible field names
    return (
      product?.imageUrl ||
      product?.image ||
      product?.primaryImage ||
      product?.primaryImageUrl ||
      (Array.isArray(product?.images) && product.images[0]) ||
      ""
    );
  }

  // ---- ShoppingCart Class ----
  class ShoppingCart {
    constructor() {
      this.cartItems = [];
      this.cartCount = 0;

      this.auth = auth;
      this.db = db;

      this.currentUser = null;
      this._authUnsub = null;
      this._ready = false;

      if (this.auth && this.db) {
        this.init();
      } else {
        // still allow local-only cart
        this.loadCartFromLocal();
        this.updateCartCount();
        this.updateCartUI();
        emit("cartUpdated", { items: this.cartItems, count: this.cartCount });
      }
    }

    init(externalAuth = null, externalDb = null) {
      this.auth = externalAuth || auth;
      this.db = externalDb || db;

      if (!this.auth) {
        console.error("Firebase Auth not available.");
        return;
      }

      // Prevent duplicate listeners
      if (this._authUnsub) return;

      this._authUnsub = this.auth.onAuthStateChanged(async (user) => {
        this.currentUser = user || null;

        if (user) {
          await this.loadCart(); // tries Firestore first, then local
        } else {
          // keep local cart if you want, or clear:
          // Here: keep local cart so a buyer doesn't lose items while signing in/out,
          // but Firestore saving only happens when signed in.
          this.loadCartFromLocal();
          this.updateCartCount();
          this.updateCartUI();
          emit("cartUpdated", { items: this.cartItems, count: this.cartCount });
        }

        this._ready = true;
        emit("cartReady", { user: !!this.currentUser });
      });
    }

    isReady() {
      return this._ready;
    }

    // ---------- Local Storage ----------
    loadCartFromLocal() {
      const saved = localStorage.getItem(LS_CART_KEY);
      const items = safeJSONParse(saved, []);
      this.cartItems = Array.isArray(items) ? items : [];
      return this.cartItems;
    }

    saveCartToLocal() {
      try {
        localStorage.setItem(LS_CART_KEY, JSON.stringify(this.cartItems || []));
        localStorage.setItem(LS_CART_UPDATED_KEY, nowISO());
      } catch (e) {
        console.warn("Failed to save cart to localStorage:", e);
      }
    }

    // ---------- Firestore ----------
    cartDocRef() {
      if (!this.db || !this.currentUser) return null;
      return this.db.collection("carts").doc(this.currentUser.uid);
    }

    async loadCart() {
      // Always start with local so UI isn't empty while Firestore loads
      this.loadCartFromLocal();
      this.updateCartCount();
      this.updateCartUI();
      emit("cartUpdated", { items: this.cartItems, count: this.cartCount });

      if (!this.currentUser || !this.db) return;

      try {
        const ref = this.cartDocRef();
        if (!ref) return;

        const snap = await ref.get();
        if (snap.exists) {
          const data = snap.data() || {};
          const items = Array.isArray(data.items) ? data.items : [];
          this.cartItems = items;
          this.saveCartToLocal();
          console.log("Cart loaded from Firestore:", items.length, "items");
        } else {
          // If Firestore empty but local has items, sync them up
          const localItems = this.cartItems || [];
          if (localItems.length) {
            await this.saveCart(); // will write local items to Firestore
          } else {
            this.cartItems = [];
          }
        }

        this.updateCartCount();
        this.updateCartUI();
        emit("cartUpdated", { items: this.cartItems, count: this.cartCount });
      } catch (error) {
        console.warn("Error loading cart from Firestore (using local fallback):", error);
        // keep local cart as fallback
        this.loadCartFromLocal();
        this.updateCartCount();
        this.updateCartUI();
        emit("cartUpdated", { items: this.cartItems, count: this.cartCount });
      }
    }

    async saveCart() {
      // always save local first
      this.saveCartToLocal();

      if (!this.currentUser || !this.db) {
        return { ok: false, mode: "local-only" };
      }

      try {
        const ref = this.cartDocRef();
        if (!ref) return { ok: false, mode: "local-only" };

        await ref.set(
          {
            items: this.cartItems,
            updatedAt: firebase.firestore.FieldValue.serverTimestamp()
          },
          { merge: true }
        );

        console.log("Cart saved to Firestore:", (this.cartItems || []).length, "items");
        return { ok: true, mode: "firestore" };
      } catch (error) {
        console.warn("Cart save failed (using local fallback):", error);
        return { ok: false, mode: "local-only", error };
      }
    }

    // ---------- Cart Ops ----------
    async addToCart(product, quantity = 1) {
      if (!this.currentUser) {
        alert("Please sign in to add items to cart");
        window.location.href = "login.html";
        return false;
      }

      quantity = parseInt(quantity, 10);
      if (!isFinite(quantity) || quantity < 1) quantity = 1;

      const productId = product?.id || product?.listingId || product?.docId;
      if (!productId) {
        console.error("addToCart failed: product missing id", product);
        alert("This product is missing an ID and can't be added yet.");
        return false;
      }

      const existingIndex = this.cartItems.findIndex((item) => item.id === productId);
      const price = normalizePrice(product);

      if (existingIndex > -1) {
        this.cartItems[existingIndex].quantity += quantity;
      } else {
        this.cartItems.push({
          id: productId,
          title: product?.title || "Untitled Product",
          subtitle: product?.subtitle || "",
          price: price,
          currency: product?.currency || "USD",
          imageUrl: normalizeImageUrl(product),
          vendor: product?.vendor || product?.vendorName || "",
          vendorUid: product?.vendorUid || product?.ownerId || product?.vendorId || "",
          quantity: quantity,
          addedAt: nowISO()
        });
      }

      const res = await this.saveCart();
      this.updateCartCount();
      this.updateCartUI();
      emit("cartUpdated", { items: this.cartItems, count: this.cartCount });

      if (!res.ok && res.mode === "local-only") {
        // Still show success, but let you know it’s local-only
        console.warn("Cart saved locally only (Firestore blocked/permissions).");
      }

      return true;
    }

    async removeFromCart(productId) {
      const idx = this.cartItems.findIndex((item) => item.id === productId);
      if (idx === -1) return;
      this.cartItems.splice(idx, 1);

      await this.saveCart();
      this.updateCartCount();
      this.updateCartUI();
      emit("cartUpdated", { items: this.cartItems, count: this.cartCount });
    }

    async updateQuantity(productId, quantity) {
      const idx = this.cartItems.findIndex((item) => item.id === productId);
      if (idx === -1) return;

      quantity = parseInt(quantity, 10);
      if (!isFinite(quantity)) quantity = 1;

      if (quantity <= 0) {
        this.cartItems.splice(idx, 1);
      } else {
        this.cartItems[idx].quantity = quantity;
      }

      await this.saveCart();
      this.updateCartCount();
      this.updateCartUI();
      emit("cartUpdated", { items: this.cartItems, count: this.cartCount });
    }

    async clearCart() {
      this.cartItems = [];
      await this.saveCart();
      this.updateCartCount();
      this.updateCartUI();
      emit("cartUpdated", { items: this.cartItems, count: this.cartCount });
    }

    updateCartCount() {
      this.cartCount = (this.cartItems || []).reduce((t, it) => t + (parseInt(it.quantity, 10) || 0), 0);
    }

    updateCartUI() {
      // Update cart badge(s)
      const els = document.querySelectorAll(".lv-cart-count");
      els.forEach((el) => {
        if (this.cartCount > 0) {
          el.textContent = String(this.cartCount);
          el.style.display = "flex";
        } else {
          el.style.display = "none";
        }
      });
    }

    getCartTotal() {
      return (this.cartItems || []).reduce((total, item) => {
        const p = Number(item.price) || 0;
        const q = Number(item.quantity) || 0;
        return total + p * q;
      }, 0);
    }

    getCartItems() { return this.cartItems; }
    getCartCount() { return this.cartCount; }

    // ---------- Wishlist (buyers/{uid}.wishlist) ----------
    async addToWishlist(product) {
      if (!this.currentUser) {
        alert("Please sign in to add items to wishlist");
        window.location.href = "login.html";
        return false;
      }
      if (!this.db) return false;

      try {
        const buyerRef = this.db.collection("buyers").doc(this.currentUser.uid);
        const snap = await buyerRef.get();
        const buyerData = snap.exists ? (snap.data() || {}) : {};
        const wishlist = Array.isArray(buyerData.wishlist) ? buyerData.wishlist : [];

        const productId = product?.id || product?.listingId || product?.docId;
        if (!productId) return false;

        if (wishlist.some((it) => it.id === productId)) return false;

        wishlist.push({
          id: productId,
          title: product?.title || "Untitled Product",
          subtitle: product?.subtitle || "",
          price: normalizePrice(product),
          currency: product?.currency || "USD",
          imageUrl: normalizeImageUrl(product),
          vendor: product?.vendor || product?.vendorName || "",
          vendorUid: product?.vendorUid || product?.ownerId || product?.vendorId || "",
          addedAt: nowISO()
        });

        await buyerRef.set(
          {
            wishlist: wishlist,
            updatedAt: firebase.firestore.FieldValue.serverTimestamp()
          },
          { merge: true }
        );

        emit("wishlistUpdated", {});
        return true;
      } catch (e) {
        console.error("Error adding to wishlist:", e);
        return false;
      }
    }

    async removeFromWishlist(productId) {
      if (!this.currentUser || !this.db) return false;

      try {
        const buyerRef = this.db.collection("buyers").doc(this.currentUser.uid);
        const snap = await buyerRef.get();
        const buyerData = snap.exists ? (snap.data() || {}) : {};
        const wishlist = Array.isArray(buyerData.wishlist) ? buyerData.wishlist : [];

        const updated = wishlist.filter((it) => it.id !== productId);

        await buyerRef.set(
          {
            wishlist: updated,
            updatedAt: firebase.firestore.FieldValue.serverTimestamp()
          },
          { merge: true }
        );

        emit("wishlistUpdated", {});
        return true;
      } catch (e) {
        console.error("Error removing from wishlist:", e);
        return false;
      }
    }

    async getWishlist() {
      if (!this.currentUser || !this.db) return [];
      try {
        const buyerRef = this.db.collection("buyers").doc(this.currentUser.uid);
        const snap = await buyerRef.get();
        const buyerData = snap.exists ? (snap.data() || {}) : {};
        return Array.isArray(buyerData.wishlist) ? buyerData.wishlist : [];
      } catch (e) {
        console.error("Error getting wishlist:", e);
        return [];
      }
    }

    // ---------- Following (buyers/{uid}.following) ----------
    async followStore(vendorUid, storeName) {
      if (!this.currentUser) {
        alert("Please sign in to follow stores");
        window.location.href = "login.html";
        return false;
      }
      if (!this.db) return false;

      try {
        const buyerRef = this.db.collection("buyers").doc(this.currentUser.uid);
        const snap = await buyerRef.get();
        const buyerData = snap.exists ? (snap.data() || {}) : {};
        const following = Array.isArray(buyerData.following) ? buyerData.following : [];

        if (following.some((s) => s.vendorUid === vendorUid)) return false;

        following.push({
          vendorUid: vendorUid,
          storeName: storeName || "",
          followedAt: nowISO()
        });

        await buyerRef.set(
          {
            following: following,
            updatedAt: firebase.firestore.FieldValue.serverTimestamp()
          },
          { merge: true }
        );

        emit("followingUpdated", {});
        return true;
      } catch (e) {
        console.error("Error following store:", e);
        return false;
      }
    }

    async unfollowStore(vendorUid) {
      if (!this.currentUser || !this.db) return false;

      try {
        const buyerRef = this.db.collection("buyers").doc(this.currentUser.uid);
        const snap = await buyerRef.get();
        const buyerData = snap.exists ? (snap.data() || {}) : {};
        const following = Array.isArray(buyerData.following) ? buyerData.following : [];

        const updated = following.filter((s) => s.vendorUid !== vendorUid);

        await buyerRef.set(
          {
            following: updated,
            updatedAt: firebase.firestore.FieldValue.serverTimestamp()
          },
          { merge: true }
        );

        emit("followingUpdated", {});
        return true;
      } catch (e) {
        console.error("Error unfollowing store:", e);
        return false;
      }
    }

    async getFollowedStores() {
      if (!this.currentUser || !this.db) return [];
      try {
        const buyerRef = this.db.collection("buyers").doc(this.currentUser.uid);
        const snap = await buyerRef.get();
        const buyerData = snap.exists ? (snap.data() || {}) : {};
        return Array.isArray(buyerData.following) ? buyerData.following : [];
      } catch (e) {
        console.error("Error getting followed stores:", e);
        return [];
      }
    }

    async isFollowingStore(vendorUid) {
      const list = await this.getFollowedStores();
      return list.some((s) => s.vendorUid === vendorUid);
    }
  }

  // Create ONE global cart instance
  const cart = new ShoppingCart();

  // expose globally
  window.cart = cart;
  window.LumiVueCart = cart;

  // helpful log
  console.log("LumiVue cart.js loaded. Firestore:", !!db, "Auth:", !!auth);
})();
