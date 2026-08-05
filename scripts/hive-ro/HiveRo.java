import java.sql.*;
public class HiveRo {
  public static void main(String[] args) throws Exception {
    if (args.length < 1) { System.err.println("usage: HiveRo <sql>"); System.exit(2); }
    String url = System.getenv().getOrDefault("HIVE_JDBC_URL", "jdbc:hive2://localhost:10001");
    Class.forName("org.apache.hive.jdbc.HiveDriver");
    try (Connection c = DriverManager.getConnection(url);
         Statement s = c.createStatement()) {
      boolean hasResult = s.execute(args[0]);
      if (!hasResult) {
        System.out.println("ok,updateCount=" + s.getUpdateCount());
        return;
      }
      try (ResultSet rs = s.getResultSet()) {
        ResultSetMetaData md = rs.getMetaData();
        int n = md.getColumnCount();
        StringBuilder header = new StringBuilder();
        for (int i = 1; i <= n; i++) {
          if (i > 1) header.append('\t');
          header.append(md.getColumnLabel(i));
        }
        System.out.println(header);
        int rows = 0;
        int limit = 100;
        while (rs.next() && rows < limit) {
          StringBuilder line = new StringBuilder();
          for (int i = 1; i <= n; i++) {
            if (i > 1) line.append('\t');
            String v = rs.getString(i);
            line.append(v == null ? "" : v.replace('\t', ' ').replace('\n', ' '));
          }
          System.out.println(line);
          rows++;
        }
      }
    }
  }
}
