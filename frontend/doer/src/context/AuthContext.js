import { createContext, useState, useEffect } from "react";
import axios from "../api/axios";

export const AuthContext = createContext();

export function AuthProvider({ children }) {
  // Read the session synchronously so a page refresh keeps the user on the same route
  // (previously state started as null and every refresh bounced to /login).
  const [user, setUser] = useState(() => {
    try {
      const u = localStorage.getItem("user");
      return u && localStorage.getItem("token") ? JSON.parse(u) : null;
    } catch {
      return null;
    }
  });
  const [token, setToken] = useState(() => localStorage.getItem("token"));

  // Initial user and token check in localStorage on page load
  useEffect(() => {
    const savedUser = localStorage.getItem("user");
    const savedToken = localStorage.getItem("token");
    if (savedUser && savedToken) {
      setUser(JSON.parse(savedUser)); // Set the user data in state
      setToken(savedToken);           // Set the token in state
    }
  }, []);

  // Login function with error handling
  const login = async (employeeID, password) => {
    try {
      const res = await axios.post("/auth/login", { employeeID, password });
       console.log("res.data : ", res);
      setUser(res.data.user); // Set user in state
      setToken(res.data.token); // Set token in state
      localStorage.setItem("user", JSON.stringify(res.data.user)); // Store user in localStorage
      localStorage.setItem("token", res.data.token); // Store token in localStorage
    } catch (error) {
      console.error("Login failed:", error);
      throw new Error("Invalid credentials or network error");
    }
  };

  // Update the cached user after a profile edit (Topbar calls this).
  const updateUser = (next) => {
    setUser(next);
    localStorage.setItem("user", JSON.stringify(next));
  };

  // Logout function
  const logout = () => {
    setUser(null);
    setToken(null);
    localStorage.removeItem("user");
    localStorage.removeItem("token");
  };

  return (
    <AuthContext.Provider value={{ user, token, login, logout, updateUser }}>
      {children}
    </AuthContext.Provider>
  );
}
