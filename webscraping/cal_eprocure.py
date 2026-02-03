"""
Robust CaleProcure Scraper with Progress Saving
- Saves progress after each event
- Can resume if interrupted
- Handles errors gracefully
"""

from selenium import webdriver
from selenium.webdriver.common.by import By
from selenium.webdriver.support.ui import WebDriverWait
from selenium.webdriver.support import expected_conditions as EC
from selenium.webdriver.chrome.service import Service
from webdriver_manager.chrome import ChromeDriverManager
import csv
import json
import time
import os
from datetime import datetime

SEARCH_URL = 'https://caleprocure.ca.gov/pages/Events-BS3/event-search.aspx'
OUTPUT_CSV = 'all_events_detailed.csv'
OUTPUT_JSON = 'all_events_detailed.json'
PROGRESS_FILE = 'scrape_progress.json'

class RobustEventScraper:
    def __init__(self, headless=False):
        """Initialize the scraper"""
        print("Initializing Robust CaleProcure Scraper")
        print("=" * 80)
        
        options = webdriver.ChromeOptions()
        if headless:
            options.add_argument('--headless')
        options.add_argument('--no-sandbox')
        options.add_argument('--disable-dev-shm-usage')
        options.add_argument('--window-size=1920,1080')
        
        service = Service(ChromeDriverManager().install())
        self.driver = webdriver.Chrome(service=service, options=options)
        self.wait = WebDriverWait(self.driver, 20)
        
        # Load progress if exists
        self.completed_urls = set()
        if os.path.exists(PROGRESS_FILE):
            try:
                with open(PROGRESS_FILE, 'r') as f:
                    progress = json.load(f)
                    self.completed_urls = set(progress.get('completed_urls', []))
                    print(f"\n✓ Loaded progress: {len(self.completed_urls)} events already scraped")
            except:
                pass
    
    def save_progress(self, url):
        """Save progress after each event"""
        self.completed_urls.add(url)
        try:
            with open(PROGRESS_FILE, 'w') as f:
                json.dump({'completed_urls': list(self.completed_urls)}, f)
        except:
            pass
    
    def get_event_count(self):
        """Get total number of events"""
        print("\n1. Loading search page...")
        self.driver.get(SEARCH_URL)
        
        print("2. Waiting for data to load...")
        time.sleep(10)
        
        print("\n3. Counting events...")
        all_rows = self.driver.find_elements(By.CSS_SELECTOR, '[data-if-label^="tblBodyTr"]')
        visible_rows = [row for row in all_rows if 'if-hide' not in (row.get_attribute('class') or '') and row.is_displayed()]
        
        return len(visible_rows)
    
    def get_event_url_at_index(self, index):
        """Get event URL at specific index (robust method)"""
        max_retries = 3
        
        for attempt in range(max_retries):
            try:
                # Always start from search page
                if self.driver.current_url != SEARCH_URL:
                    self.driver.get(SEARCH_URL)
                    time.sleep(3)
                
                # Find all rows
                all_rows = self.driver.find_elements(By.CSS_SELECTOR, '[data-if-label^="tblBodyTr"]')
                visible_rows = [row for row in all_rows if 'if-hide' not in (row.get_attribute('class') or '') and row.is_displayed()]
                
                if index >= len(visible_rows):
                    return None, None, None
                
                row = visible_rows[index]
                
                # Get info
                event_id = row.find_element(By.CSS_SELECTOR, '[data-if-label="tdEventId"]').text.strip()
                title = row.find_element(By.CSS_SELECTOR, '[data-if-label="tdEventName"]').text.strip()
                
                # Click
                event_id_cell = row.find_element(By.CSS_SELECTOR, '[data-if-label="tdEventId"]')
                original_url = self.driver.current_url
                
                event_id_cell.click()
                time.sleep(2)
                
                new_url = self.driver.current_url
                
                if new_url != original_url:
                    return event_id, title, new_url
                else:
                    return event_id, title, None
                    
            except Exception as e:
                if attempt < max_retries - 1:
                    print(f"    Retry {attempt + 1}/{max_retries}...")
                    time.sleep(2)
                else:
                    print(f"    Failed after {max_retries} attempts: {e}")
                    return None, None, None
        
        return None, None, None
    
    def scrape_event_detail(self, event_url):
        """Scrape all details from an event detail page - using proven extraction logic"""
        event_data = {
            'event_url': event_url,
            'event_id': '',
            'title': '',
            'description': '',
            'contact_name': '',
            'contact_email': '',
            'contact_phone': '',
            'department': '',
            'start_date': '',
            'end_date': '',
            'format': ''
        }
        
        # Extract event ID from URL
        parts = event_url.split('/')
        if len(parts) >= 4:
            event_data['event_id'] = f"{parts[-2]}/{parts[-1]}"
        
        # Load the page
        try:
            self.driver.get(event_url)
            
            # Wait for JavaScript to load data
            self.wait.until(
                EC.presence_of_element_located((By.CSS_SELECTOR, '[data-if-label="eventName"]'))
            )
            
            # Give extra time for all data to load
            time.sleep(3)
            
        except Exception as e:
            print(f"    ⚠ Error loading page: {e}")
            return event_data
        
        # Extract title
        try:
            title_elem = self.driver.find_element(By.CSS_SELECTOR, '[data-if-label="eventName"]')
            title = title_elem.text.strip()
            if title and title != '[Event Title]':
                event_data['title'] = title
        except:
            pass
        
        # Extract description
        try:
            desc_elem = self.driver.find_element(By.CSS_SELECTOR, '[data-if-label="descriptiondetails"]')
            desc = desc_elem.text.strip()
            if desc and desc != '[Detail Description]':
                event_data['description'] = desc
        except:
            pass
        
        # Extract contact name
        try:
            contact_elem = self.driver.find_element(By.CSS_SELECTOR, '[data-if-label="contactName"]')
            contact = contact_elem.text.strip()
            if contact and contact != '[Contact Name]':
                event_data['contact_name'] = contact
        except:
            pass
        
        # Extract email
        try:
            email_elem = self.driver.find_element(By.CSS_SELECTOR, '[data-if-label="emailAnchor"]')
            email = email_elem.text.strip()
            if email and email != '[EmailAddress]':
                event_data['contact_email'] = email
        except:
            try:
                email_elem = self.driver.find_element(By.ID, 'RESP_INQ_DL0_WK_EMAILID')
                email = email_elem.text.strip()
                if email:
                    event_data['contact_email'] = email
            except:
                pass
        
        # Extract phone
        try:
            phone_elem = self.driver.find_element(By.CSS_SELECTOR, '[data-if-label="phoneText"]')
            phone = phone_elem.text.strip()
            if phone and phone != '[Phone Number]':
                event_data['contact_phone'] = phone
        except:
            pass
        
        # Extract department
        try:
            dept_elem = self.driver.find_element(By.CSS_SELECTOR, '[data-if-label="dept"]')
            dept = dept_elem.text.strip()
            if dept:
                event_data['department'] = dept
        except:
            pass
        
        # Extract start date
        try:
            start_elem = self.driver.find_element(By.CSS_SELECTOR, '[data-if-label="eventStartDate"]')
            start_date = start_elem.text.strip()
            if start_date:
                event_data['start_date'] = start_date
        except:
            pass
        
        # Extract end date
        try:
            end_elem = self.driver.find_element(By.CSS_SELECTOR, '[data-if-label="eventEndDate"]')
            end_date = end_elem.text.strip()
            if end_date:
                event_data['end_date'] = end_date
        except:
            pass
        
        # Extract format
        try:
            format1_elem = self.driver.find_element(By.CSS_SELECTOR, '[data-if-label="format1"]')
            format2_elem = self.driver.find_element(By.CSS_SELECTOR, '[data-if-label="format2"]')
            format1 = format1_elem.text.strip()
            format2 = format2_elem.text.strip()
            if format1 or format2:
                event_data['format'] = f"{format1} / {format2}".strip(' /')
        except:
            pass
        
        return event_data
    
    def scrape_all_events(self, max_events=None):
        """Main scraping function with progress saving"""
        
        # Get total count
        total_events = self.get_event_count()
        print(f"   Found {total_events} total events")
        
        if len(self.completed_urls) > 0:
            print(f"   Already completed: {len(self.completed_urls)} events")
            print(f"   Remaining: {total_events - len(self.completed_urls)} events")
        
        if max_events:
            total_events = min(total_events, max_events)
            print(f"   Limiting to {max_events} events")
        
        all_event_data = []
        
        # Load existing data if resuming
        if os.path.exists(OUTPUT_JSON):
            try:
                with open(OUTPUT_JSON, 'r') as f:
                    existing = json.load(f)
                    all_event_data = existing.get('events', [])
                    print(f"   Loaded {len(all_event_data)} existing events from {OUTPUT_JSON}")
            except:
                pass
        
        print(f"\n4. Scraping events...")
        print("=" * 80)
        
        # Process each event by index
        for i in range(total_events):
            event_num = i + 1
            
            print(f"\nEvent {event_num}/{total_events}:")
            
            try:
                # Get event URL
                event_id, title, url = self.get_event_url_at_index(i)
                
                if not url:
                    print(f"  ⚠ Could not get URL, skipping")
                    continue
                
                # Skip if already completed
                if url in self.completed_urls:
                    print(f"  ⏭ Already scraped, skipping")
                    continue
                
                print(f"  ID: {event_id}")
                print(f"  Title: {title[:60]}...")
                print(f"  URL: {url}")
                
                # Scrape details
                print(f"  Scraping details...")
                event_data = self.scrape_event_detail(url)
                
                all_event_data.append(event_data)
                print(f"  ✓ Scraped successfully")
                
                # Show key fields
                if event_data['contact_email']:
                    print(f"    Contact: {event_data['contact_email']}")
                if event_data['end_date']:
                    print(f"    End Date: {event_data['end_date']}")
                
                # Save progress
                self.save_progress(url)
                
                # Save data incrementally every 10 events
                if len(all_event_data) % 10 == 0:
                    self.save_to_json(all_event_data, OUTPUT_JSON)
                    print(f"  💾 Progress saved ({len(all_event_data)} events)")
                
            except KeyboardInterrupt:
                print("\n\n⚠ Interrupted by user")
                print(f"Saving progress... ({len(all_event_data)} events scraped)")
                self.save_to_json(all_event_data, OUTPUT_JSON)
                self.save_to_csv(all_event_data, OUTPUT_CSV)
                raise
                
            except Exception as e:
                print(f"  ✗ Error: {e}")
                continue
        
        print("\n" + "=" * 80)
        print(f"Scraping complete! Collected {len(all_event_data)} events")
        
        return all_event_data
    
    def save_to_csv(self, events, filename=OUTPUT_CSV):
        """Save events to CSV"""
        if not events:
            return
        
        print(f"\nSaving to {filename}...")
        
        fieldnames = [
            'event_id', 'event_url', 'title', 'description',
            'department', 'format', 'start_date', 'end_date',
            'contact_name', 'contact_email', 'contact_phone'
        ]
        
        with open(filename, 'w', newline='', encoding='utf-8') as f:
            writer = csv.DictWriter(f, fieldnames=fieldnames)
            writer.writeheader()
            writer.writerows(events)
        
        print(f"✓ Saved {len(events)} events to {filename}")
    
    def save_to_json(self, events, filename=OUTPUT_JSON):
        """Save events to JSON"""
        if not events:
            return
        
        data = {
            'scrape_date': datetime.now().isoformat(),
            'total_events': len(events),
            'events': events
        }
        
        with open(filename, 'w', encoding='utf-8') as f:
            json.dump(data, f, indent=2, ensure_ascii=False)
    
    def close(self):
        """Close the browser"""
        self.driver.quit()


def main():
    """Main function"""
    print("\n" + "=" * 80)
    print("Robust CaleProcure Event Scraper")
    print("Features: Progress saving, resume capability, error recovery")
    print("=" * 80)
    
    scraper = RobustEventScraper(headless=False)
    
    try:
        # Scrape events
        events = scraper.scrape_all_events(max_events=None)  # None = all events
        
        # Final save
        scraper.save_to_csv(events)
        scraper.save_to_json(events)
        
        print("\n" + "=" * 80)
        print("✓ All done!")
        print(f"\nFiles created:")
        print(f"  - {OUTPUT_CSV}")
        print(f"  - {OUTPUT_JSON}")
        
        # Clean up progress file
        if os.path.exists(PROGRESS_FILE):
            os.remove(PROGRESS_FILE)
            print(f"  - Cleaned up {PROGRESS_FILE}")
        
        if events:
            print(f"\nTotal events scraped: {len(events)}")
        
        print("\n" + "=" * 80)
        
    except KeyboardInterrupt:
        print("\n\nScraping interrupted by user")
        print("Progress has been saved. Run again to resume.")
        
    except Exception as e:
        print(f"\n✗ Error: {e}")
        import traceback
        traceback.print_exc()
    
    finally:
        scraper.close()
        print("\nBrowser closed.")


if __name__ == '__main__':
    main()